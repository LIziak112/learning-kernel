import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { studentTool } from "../builtins/reading-capabilities.ts";
import { selectedText } from "../builtins/selection.ts";
import type { SubmitInput } from "../contracts/reading.ts";
import type { ReadingStep } from "../contracts/reading-publication.ts";
import { readingAnswer, readingSelection } from "../contracts/reading-runtime.ts";
import type { ReadingAnswerInput, ReadingSaveInput, ReadingSelection } from "../contracts/reading-runtime.ts";
import type { ReadingActivity } from "./activity.ts";
import { queueEvaluation } from "./evaluation.ts";
import { LearningError } from "./learning-error.ts";
import { answerObservations, findSource, verifyAnswerReferences } from "./reading-answers.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { studentResults } from "./student-results.ts";
import { finishActivity, recordSubmission, recoverReceipt } from "./submission-store.ts";
import type { StoredSubmission } from "./submission-store.ts";
import { loadWorkVersion, saveWorkVersion } from "./work-versions.ts";

function stepForAttempt(database: DatabaseSync, activity: ReadingActivity, attemptId: string) {
  const row = database.prepare("SELECT step_id FROM step_attempts WHERE id = ? AND activity_id = ?")
    .get(attemptId, activity.activityId);
  const step = activity.practice.steps.find(step => step.id === row?.step_id);
  if (!step) throw new LearningError(403, "FORBIDDEN");
  return step;
}

function boundOutput(step: ReadingStep, slotId: string) {
  const slot = step.submit.slots[slotId];
  if (!slot || slot.type === "reuse" || !studentTool(step.tool)?.outputs.includes(slot.type)) {
    throw new LearningError(422, "INVALID_SLOT");
  }
  return slot;
}

function workScope(activity: ReadingActivity, input: { stepAttemptId: string; slotId: string }) {
  return { activityId: activity.activityId, step: { id: input.stepAttemptId, slotId: input.slotId } };
}

export function saveReadingSelection(database: DatabaseSync, activity: ReadingActivity, input: ReadingSaveInput) {
  const step = stepForAttempt(database, activity, input.stepAttemptId);
  const slot = boundOutput(step, input.slotId);
  if (slot.type !== "passageSelection") throw new LearningError(422, "INVALID_SLOT");
  const source = step.inputs[slot.source];
  if (source?.from !== "material") throw new LearningError(409, "PRACTICE_NOT_RUNNABLE");
  const selection = {
    material: activity.practice.material,
    positionId: source.positionId,
    ranges: input.ranges.map(({ role, ...range }) => {
      if (!Object.hasOwn(slot.oneRangePerRole, role)) throw new LearningError(422, "INVALID_SELECTION");
      return { role, range, text: selectedText(activity.material, range) };
    }),
  };
  const draft = saveWorkVersion(database, workScope(activity, input), selection, input.workId);
  return { draft, selection };
}

export function saveReadingAnswer(database: DatabaseSync, activity: ReadingActivity, input: ReadingAnswerInput) {
  const step = stepForAttempt(database, activity, input.stepAttemptId);
  if (boundOutput(step, input.slotId).type !== "oneChoicePerQuestion") throw new LearningError(422, "INVALID_SLOT");
  const { choices, references, reason } = input;
  const answer = readingAnswer.parse({ choices, references, reason });
  verifyAnswerReferences(database, activity.activityId, step, answer);
  return { draft: saveWorkVersion(database, workScope(activity, input), answer, input.workId), answer };
}

export function confirmReadingDraft(
  database: DatabaseSync, activity: ReadingActivity, input: SubmitInput, clock: () => Date, checkpoint?: RuntimeCheckpoint,
) {
  const step = stepForAttempt(database, activity, input.stepAttemptId);
  const repeated = recoverReceipt(database, input);
  if (repeated) return repeated;
  if (activity.completed || activity.stepAttemptId !== input.stepAttemptId) {
    throw new LearningError(409, "ALREADY_SUBMITTED");
  }
  const confirmedAt = clock();
  requireBeforeDeadline(activity, confirmedAt);
  const slot = boundOutput(step, input.slotId);
  const content = loadWorkVersion(database, workScope(activity, input), input.draft);
  const observations = readingObservations(database, activity, slot, content);
  const receipt = recordSubmission(database, input, observations, confirmedAt);
  if (slot.type === "oneChoicePerQuestion") queueEvaluation(database, activity, receipt, slot.targetId);
  if (step.afterConfirmation === "finish") finishActivity(database, activity.activityId, receipt.id);
  else advanceReading(database, activity);
  checkpoint?.({ point: "beforeConfirmationCommit", operationId: input.operationId });
  return receipt;
}

function requireBeforeDeadline(activity: ReadingActivity, confirmedAt: Date) {
  const limit = activity.practice.policy.timeLimit;
  if (!limit) return;
  const deadline = Date.parse(activity.startedAt) + limit.minutes * 60_000;
  if (confirmedAt.getTime() >= deadline) throw new LearningError(409, "DEADLINE_PASSED");
}

function readingObservations(
  database: DatabaseSync,
  activity: ReadingActivity,
  slot: ReturnType<typeof boundOutput>,
  content: unknown,
) {
  if (slot.type === "oneChoicePerQuestion") {
    const answer = readingAnswer.parse(content);
    verifyAnswerReferences(database, activity.activityId, activity.step, answer);
    return answerObservations(activity, slot, answer);
  }
  const selection = readingSelection.parse(content);
  validateSelection(selection, Object.keys(slot.oneRangePerRole), slot.distinctParagraphs);
  return [{ targetId: slot.targetId, unitId: slot.evidenceUnit }];
}

function validateSelection(selection: ReadingSelection, requiredRoles: string[], distinctParagraphs: boolean) {
  const roles = new Set(selection.ranges.map(item => item.role));
  if (selection.ranges.length !== requiredRoles.length || requiredRoles.some(role => !roles.has(role))) {
    throw new LearningError(422, "INCOMPLETE_SELECTION");
  }
  const paragraphs = new Set(selection.ranges.map(item => item.range.paragraphId));
  if (distinctParagraphs && paragraphs.size !== selection.ranges.length) {
    throw new LearningError(422, "SELECTION_REQUIRES_DISTINCT_PARAGRAPHS");
  }
}

function advanceReading(database: DatabaseSync, activity: ReadingActivity) {
  const ordinal = activity.practice.steps.indexOf(activity.step) + 1;
  const next = activity.practice.steps[ordinal];
  if (!next) throw new Error("已发布声明缺少下一步");
  database.prepare("INSERT INTO step_attempts (id, activity_id, step_id, ordinal) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), activity.activityId, next.id, ordinal);
}

export function readingActivityView(database: DatabaseSync, activity: ReadingActivity, submissions: StoredSubmission[]) {
  const { activityId, stepAttemptId, startedAt, step, practice, completed } = activity;
  const submitted = submissions.find(item => item.receipt.stepAttemptId === stepAttemptId);
  const materialBound = Object.values(step.inputs).some(input => input.from === "material");
  return {
    formatVersion: practice.formatVersion,
    activityId, stepAttemptId, startedAt, material: materialBound ? activity.material : undefined, redoOf: activity.redoOf,
    title: practice.title,
    step: { id: step.id, instructions: step.instructions, tool: step.tool, submit: step.submit },
    status: completed ? "completed" : "active",
    inputs: readingInputs(activity, submissions),
    submission: submitted ? studentSubmissionView(activity, submitted) : undefined,
    ...studentResults(database, activity),
  };
}

function readingInputs(activity: ReadingActivity, submissions: StoredSubmission[]) {
  const { completed, practice, step } = activity;
  return Object.fromEntries(Object.entries(step.inputs).flatMap<[string, object]>(([name, input]) => {
    switch (input.from) {
      case "material": return [[name, { from: input.from, positionId: input.positionId }]];
      case "questions": return [[name, { from: input.from, questions: practice.questions }]];
      case "submission": {
        const submitted = findSource(submissions, input);
        if (!submitted) throw new Error("前序步骤缺少已确认的输入");
        const view = completed ? studentSubmissionView(activity, submitted) : readingSubmissionView(submitted);
        return Object.keys(view).length ? [[name, { from: input.from, ...view }]] : [];
      }
    }
  }));
}

export function studentSubmissionView(activity: ReadingActivity, submitted: StoredSubmission) {
  const fields = new Set(activity.practice.policy.student.ownSubmission.fields);
  const view = readingSubmissionView(submitted);
  const receipt = fields.has("receipt") ? { receipt: view.receipt } : {};
  if (view.selection && fields.has("submittedQuotes")) return { ...receipt, selection: view.selection };
  if (!view.answer || !fields.has("ownChoices")) return receipt;
  const { references, ...answer } = view.answer;
  return { ...receipt, answer: fields.has("receipt") ? { ...answer, references } : answer };
}

export function readingSubmissionView(submitted: StoredSubmission) {
  const selection = readingSelection.safeParse(submitted.content);
  if (selection.success) return { receipt: submitted.receipt, selection: selection.data };
  return { receipt: submitted.receipt, answer: readingAnswer.parse(submitted.content) };
}
