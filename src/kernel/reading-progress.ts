import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { studentTool } from "../builtins/reading-capabilities.ts";
import { selectedText } from "../builtins/selection.ts";
import type { SubmitInput } from "../contracts/reading.ts";
import type { ReadingStep } from "../contracts/reading-publication.ts";
import { readingSelection } from "../contracts/reading-runtime.ts";
import type { ReadingSaveInput, ReadingSelection } from "../contracts/reading-runtime.ts";
import type { ReadingActivity } from "./activity.ts";
import { LearningError } from "./learning-error.ts";
import { recordSubmission, recoverReceipt } from "./submission-store.ts";
import type { StoredSubmission } from "./submission-store.ts";
import { loadWorkVersion, saveWorkVersion } from "./work-versions.ts";

function stepForAttempt(database: DatabaseSync, activity: ReadingActivity, attemptId: string) {
  const row = database.prepare("SELECT step_id FROM step_attempts WHERE id = ? AND activity_id = ?")
    .get(attemptId, activity.activityId);
  const step = activity.practice.steps.find(step => step.id === row?.step_id);
  if (!step) throw new LearningError(403, "FORBIDDEN");
  return step;
}

function passageSlot(step: ReadingStep, slotId: string) {
  const slot = step.submit.slots[slotId];
  if (slot?.type !== "passageSelection" || !studentTool(step.tool)?.outputs.includes(slot.type)) {
    throw new LearningError(422, "INVALID_SLOT");
  }
  const source = step.inputs[slot.source];
  if (source?.from !== "material") throw new LearningError(409, "PRACTICE_NOT_RUNNABLE");
  return { slot, source };
}

function workScope(activity: ReadingActivity, input: { stepAttemptId: string; slotId: string }) {
  return { activityId: activity.activityId, step: { id: input.stepAttemptId, slotId: input.slotId } };
}

export function saveReadingSelection(database: DatabaseSync, activity: ReadingActivity, input: ReadingSaveInput) {
  const step = stepForAttempt(database, activity, input.stepAttemptId);
  const { slot, source } = passageSlot(step, input.slotId);
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

export function confirmReadingSelection(database: DatabaseSync, activity: ReadingActivity, input: SubmitInput) {
  const step = stepForAttempt(database, activity, input.stepAttemptId);
  const repeated = recoverReceipt(database, input);
  if (repeated) return repeated;
  if (activity.stepAttemptId !== input.stepAttemptId) {
    throw new LearningError(409, "ALREADY_SUBMITTED");
  }
  const { slot } = passageSlot(step, input.slotId);
  const selection = readingSelection.parse(loadWorkVersion(database, workScope(activity, input), input.draft));
  validateSelection(selection, Object.keys(slot.oneRangePerRole), slot.distinctParagraphs);
  const receipt = recordSubmission(database, input, slot.targetId);
  advanceReading(database, activity);
  return receipt;
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

export function readingActivityView(activity: ReadingActivity, submissions: StoredSubmission[]) {
  const { activityId, stepAttemptId, startedAt, material, step, practice, completed } = activity;
  const inputs = Object.fromEntries(Object.entries(step.inputs).map(([name, input]) => {
    switch (input.from) {
      case "material": return [name, { from: input.from, positionId: input.positionId }];
      case "questions": return [name, { from: input.from, questions: practice.questions }];
      case "submission": {
        const submitted = submissions.find(item => item.stepId === input.stepId && item.receipt.slotId === input.slotId);
        if (!submitted) throw new Error("前序步骤缺少已确认的输入");
        return [name, { from: input.from, ...readingSubmissionView(submitted) }];
      }
    }
  }));
  return {
    formatVersion: practice.formatVersion,
    activityId, stepAttemptId, startedAt, material,
    title: practice.title,
    step: { id: step.id, instructions: step.instructions, tool: step.tool, submit: step.submit },
    status: completed ? "completed" : "active",
    inputs,
  };
}

export function readingSubmissionView(submitted: StoredSubmission) {
  return { receipt: submitted.receipt, selection: readingSelection.parse(submitted.content) };
}
