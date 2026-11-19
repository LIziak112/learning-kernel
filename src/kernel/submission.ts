import type { DatabaseSync } from "node:sqlite";
import { draftReceipt, selectionSchema } from "../contracts/reading.ts";
import type { ActivityDetail, SaveInput, SubmitInput } from "../contracts/reading.ts";
import type { ReadingAnswerInput, ReadingSaveInput } from "../contracts/reading-runtime.ts";
import { selectText } from "../builtins/selection.ts";
import { loadStudentActivity } from "./activity.ts";
import { readChoiceDrafts } from "./choice-drafts.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { confirmReadingDraft, readingActivityView, saveReadingAnswer, saveReadingSelection, studentSubmissionView } from "./reading-progress.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { studentResults } from "./student-results.ts";
import { activitySubmissions, finishActivity, recordSubmission, recoverReceipt } from "./submission-store.ts";
import type { StoredSubmission } from "./submission-store.ts";
import { loadWorkVersion, saveWorkVersion } from "./work-versions.ts";

export function saveDraft(
  database: DatabaseSync,
  student: string,
  activityId: string,
  input: SaveInput | ReadingSaveInput | ReadingAnswerInput,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentActivity(database, student, activityId);
    if ("ranges" in input && activity.kind === "reading") return saveReadingSelection(database, activity, input);
    if ("choices" in input && activity.kind === "reading") return saveReadingAnswer(database, activity, input);
    if ("range" in input && activity.kind === "single") {
      const selection = selectText(activity.material, activity.step, input.range);
      const draft = saveWorkVersion(database, { activityId }, selection, input.workId);
      return draftReceipt.parse({ draft, selection });
    }
    throw new LearningError(422, "INVALID_DRAFT");
  });
}

export function submitDraft(
  database: DatabaseSync, student: string, activityId: string, input: SubmitInput, clock: () => Date, checkpoint?: RuntimeCheckpoint,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentActivity(database, student, activityId);
    if (activity.kind === "reading") return confirmReadingDraft(database, activity, input, clock, checkpoint);
    if (activity.stepAttemptId !== input.stepAttemptId) throw new LearningError(403, "FORBIDDEN");
    const repeated = recoverReceipt(database, input);
    if (repeated) return repeated;
    if (input.slotId !== activity.step.slotId) throw new LearningError(422, "INVALID_SLOT");
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    loadWorkVersion(database, { activityId }, input.draft);
    const receipt = recordSubmission(database, input, [{ targetId: activity.step.targetId, unitId: "wholeSelection" }], clock());
    finishActivity(database, activityId, receipt.id);
    return receipt;
  });
}

export function readActivity(database: DatabaseSync, student: string, activityId: string) {
  const activity = loadStudentActivity(database, student, activityId);
  const submissions = activitySubmissions(database, activityId);
  if (activity.kind === "reading") {
    const view = readingActivityView(database, activity, submissions);
    if (activity.completed) return view;
    const choiceDrafts = readChoiceDrafts(database, activityId, activity.stepAttemptId);
    return choiceDrafts.length > 0 ? { ...view, choiceDrafts } : view;
  }
  const { kind, completed, ...previous } = activity;
  const view: ActivityDetail = {
    ...previous,
    status: completed ? "completed" : "active",
    submission: submissions[0] ? submissionView(submissions[0]) : null,
  };
  return view;
}

export function readSubmission(database: DatabaseSync, student: string, activityId: string, submissionId: string) {
  const activity = loadStudentActivity(database, student, activityId);
  const result = activitySubmissions(database, activityId).find(item => item.receipt.id === submissionId);
  if (!result) throw new LearningError(403, "FORBIDDEN");
  return activity.kind === "reading" ? studentSubmissionView(activity, result) : submissionView(result);
}

export function readStudentFragment(database: DatabaseSync, student: string, activityId: string, submissionId: string) {
  const submission = readSubmission(database, student, activityId, submissionId);
  if (!("selection" in submission) || !submission.selection) throw new LearningError(403, "FORBIDDEN");
  return submission.selection;
}

export function readStudentResults(
  database: DatabaseSync, student: string, activityId: string, resource: "assessment" | "review" | "export",
) {
  const activity = loadStudentActivity(database, student, activityId);
  if (activity.kind !== "reading") throw new LearningError(403, "FORBIDDEN");
  const results = studentResults(database, activity);
  if (resource === "assessment") return { assessment: results.assessment };
  if (resource === "review") {
    if (!results.review) throw new LearningError(403, "FORBIDDEN");
    return results.review;
  }
  return {
    activityId, status: activity.completed ? "completed" : "active", redoOf: activity.redoOf,
    submissions: activitySubmissions(database, activityId).map(submitted => studentSubmissionView(activity, submitted)),
    ...results,
  };
}

function submissionView(submitted: StoredSubmission) {
  return { receipt: submitted.receipt, selection: selectionSchema.parse(submitted.content) };
}
