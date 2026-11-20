import type { DatabaseSync } from "node:sqlite";
import type { ChoiceDraftScope, CurrentChoiceDraftMode } from "../contracts/choice-draft.ts";
import { responseDraftValue } from "../contracts/response.ts";
import type { ResponseDraftInput, ResponseValue } from "../contracts/response.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { recordChoiceDraftChange } from "./choice-draft-activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import {
  isLatestQuestionDraftOperation, publicDraft, QuestionDraftConflict, readQuestionDraftHead, readQuestionDraftOperation,
  readQuestionDrafts, rememberQuestionDraftOperation,
} from "./question-draft-store.ts";
import { boundOutput } from "./reading-progress.ts";
import { saveWorkVersion } from "./work-versions.ts";

export class ResponseDraftConflict extends QuestionDraftConflict<{ revision: number; value: ResponseValue | null }> {}

export function responseSlot(activity: ReadingActivity, slotId: string) {
  const slot = boundOutput(activity.step, slotId);
  if (slot.type !== "oneResponsePerQuestion") throw new LearningError(422, "INVALID_SLOT");
  return slot;
}

export function readResponseDrafts(database: DatabaseSync, activityId: string, stepAttemptId: string) {
  return readQuestionDrafts(database, activityId, stepAttemptId, responseDraftValue);
}

export function saveResponseDraft(
  database: DatabaseSync, studentId: string, activityId: string, input: ResponseDraftInput,
  mode: CurrentChoiceDraftMode, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    responseSlot(activity, input.slotId);
    requireQuestionVersion(activity, input);
    return saveCurrentResponse(database, activityId, input, mode, clock);
  });
}

function requireQuestionVersion(activity: ReadingActivity, input: ChoiceDraftScope) {
  const question = activity.practice.questions.find(question => question.id === input.questionId);
  if (!question) throw new LearningError(422, "INVALID_QUESTION");
  if (question.version !== input.questionVersion) throw new LearningError(409, "QUESTION_REVISION_STALE");
}

function saveCurrentResponse(
  database: DatabaseSync, activityId: string, input: ResponseDraftInput, mode: CurrentChoiceDraftMode, clock: () => Date,
) {
  const current = readQuestionDraftHead(database, activityId, input, responseDraftValue);
  const previous = readQuestionDraftOperation(database, activityId, input, responseDraftValue);
  if (previous && current) return replayResponseOperation(database, input, current, previous);
  const state = current ?? { revision: 0, value: null };
  if (mode === "replayLatestOnly") throw new LearningError(409, "DRAFT_REPLAY_REQUIRED");
  if (state.revision !== input.baseRevision) throw new ResponseDraftConflict({ revision: state.revision, value: state.value });
  const written = current?.value === input.value ? current : appendResponse(database, activityId, input, current, clock);
  rememberQuestionDraftOperation(database, input, written);
  return publicDraft(written);
}

type ResponseHead = NonNullable<ReturnType<typeof readQuestionDraftHead<Pick<ResponseDraftInput, "questionVersion" | "value">>>>;

function replayResponseOperation(
  database: DatabaseSync, input: ResponseDraftInput, current: ResponseHead,
  previous: { baseRevision: number; draft: { value: ResponseValue } },
) {
  if (isLatestQuestionDraftOperation(database, current.workId, input.operationId)
    && previous.baseRevision === input.baseRevision && previous.draft.value === input.value) return publicDraft(current);
  throw new ResponseDraftConflict({ revision: current.revision, value: current.value }, "OPERATION_CONFLICT");
}

function appendResponse(
  database: DatabaseSync, activityId: string, input: ResponseDraftInput,
  current: { workId: string; revision: number; changeCount: number } | undefined, clock: () => Date,
) {
  const { stepAttemptId, slotId, questionId, questionVersion, value } = input;
  recordChoiceDraftChange(database, activityId, clock());
  const draft = saveWorkVersion(database, { activityId, step: { id: stepAttemptId, slotId, questionId } },
    { questionVersion, value }, current?.workId);
  return {
    workId: draft.id, workVersion: draft.version, slotId, questionId, questionVersion, value,
    revision: (current?.revision ?? 0) + 1, changeCount: (current?.changeCount ?? 0) + 1,
  };
}
