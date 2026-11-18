import type { DatabaseSync } from "node:sqlite";
import { draftReceipt, selectionSchema } from "../contracts/reading.ts";
import type { ActivityDetail, SaveInput, SubmitInput } from "../contracts/reading.ts";
import type { ReadingSaveInput } from "../contracts/reading-runtime.ts";
import { selectText } from "../builtins/selection.ts";
import { loadActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { confirmReadingSelection, readingActivityView, readingSubmissionView, saveReadingSelection } from "./reading-progress.ts";
import { activitySubmissions, finishActivity, recordSubmission, recoverReceipt } from "./submission-store.ts";
import type { StoredSubmission } from "./submission-store.ts";
import { loadWorkVersion, saveWorkVersion } from "./work-versions.ts";

export function saveDraft(database: DatabaseSync, student: string, activityId: string, input: SaveInput | ReadingSaveInput) {
  return writeTransaction(database, () => {
    const activity = loadActivity(database, student, activityId);
    if ("ranges" in input && activity.kind === "reading") return saveReadingSelection(database, activity, input);
    if ("range" in input && activity.kind === "single") {
      const selection = selectText(activity.material, activity.step, input.range);
      const draft = saveWorkVersion(database, { activityId }, selection, input.workId);
      return draftReceipt.parse({ draft, selection });
    }
    throw new LearningError(422, "INVALID_DRAFT");
  });
}

export function submitDraft(database: DatabaseSync, student: string, activityId: string, input: SubmitInput) {
  return writeTransaction(database, () => {
    const activity = loadActivity(database, student, activityId);
    if (activity.kind === "reading") return confirmReadingSelection(database, activity, input);
    if (activity.stepAttemptId !== input.stepAttemptId) throw new LearningError(403, "FORBIDDEN");
    const repeated = recoverReceipt(database, input);
    if (repeated) return repeated;
    if (input.slotId !== activity.step.slotId) throw new LearningError(422, "INVALID_SLOT");
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    loadWorkVersion(database, { activityId }, input.draft);
    const receipt = recordSubmission(database, input, activity.step.targetId);
    finishActivity(database, activityId, receipt.id);
    return receipt;
  });
}

export function readActivity(database: DatabaseSync, student: string, activityId: string) {
  const activity = loadActivity(database, student, activityId);
  const submissions = activitySubmissions(database, activityId);
  if (activity.kind === "reading") return readingActivityView(activity, submissions);
  const { kind, completed, ...previous } = activity;
  const view: ActivityDetail = {
    ...previous,
    status: completed ? "completed" : "active",
    submission: submissions[0] ? submissionView(submissions[0]) : null,
  };
  return view;
}

export function readSubmission(database: DatabaseSync, student: string, activityId: string, submissionId: string) {
  const activity = loadActivity(database, student, activityId);
  const result = activitySubmissions(database, activityId).find(item => item.receipt.id === submissionId);
  if (!result) throw new LearningError(403, "FORBIDDEN");
  return activity.kind === "reading" ? readingSubmissionView(result) : submissionView(result);
}

function submissionView(submitted: StoredSubmission) {
  return { receipt: submitted.receipt, selection: selectionSchema.parse(submitted.content) };
}
