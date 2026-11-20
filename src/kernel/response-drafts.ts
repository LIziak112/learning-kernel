import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { ChoiceDraftScope, CurrentChoiceDraftMode } from "../contracts/choice-draft.ts";
import { indexResponseDraftValue, responseDraftValue, sameStoredResponse } from "../contracts/response.ts";
import type { ResponseDraftInput, ResponseFormat, ResponseValue, StoredResponseValue } from "../contracts/response.ts";
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
export class IndexResponseDraftConflict extends QuestionDraftConflict<{ revision: number; value: number[] | null }> {
  readonly questionId: string | undefined;

  constructor(current: { revision: number; value: number[] | null }, code?: "ANSWER_REVISION_CONFLICT" | "OPERATION_CONFLICT", questionId?: string) {
    super(current, code);
    this.questionId = questionId;
  }
}

type DraftInput<Value> = Omit<ResponseDraftInput, "value"> & { value: Value };
type DraftContent<Value> = Pick<DraftInput<Value>, "questionVersion" | "value">;

export type ResponseDraftMode<Value> = {
  format: ResponseFormat;
  schema: z.ZodType<DraftContent<Value>>;
  Conflict: typeof QuestionDraftConflict<{ revision: number; value: Value | null }>;
};

export const scalarResponseDrafts: ResponseDraftMode<ResponseValue> = {
  format: "booleanOrString", schema: responseDraftValue, Conflict: ResponseDraftConflict,
};
export const indexResponseDrafts: ResponseDraftMode<number[]> = {
  format: "optionIndexArray", schema: indexResponseDraftValue, Conflict: IndexResponseDraftConflict,
};

export function responseSlot(activity: ReadingActivity, slotId: string, format: ResponseFormat) {
  const slot = boundOutput(activity.step, slotId);
  if (slot.type !== "oneResponsePerQuestion" || slot.input !== format) throw new LearningError(422, "INVALID_SLOT");
  return slot;
}

export function readResponseDrafts<Value extends StoredResponseValue>(
  database: DatabaseSync, activityId: string, stepAttemptId: string, { schema }: ResponseDraftMode<Value>,
) {
  return readQuestionDrafts(database, activityId, stepAttemptId, schema);
}

export function saveResponseDraft<Value extends StoredResponseValue>(
  database: DatabaseSync, studentId: string, activityId: string, input: DraftInput<Value>,
  mode: CurrentChoiceDraftMode, clock: () => Date, draftMode: ResponseDraftMode<Value>,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    responseSlot(activity, input.slotId, draftMode.format);
    const question = requireQuestionVersion(activity, input);
    if (typeof input.value === "object" && input.value.some(index => !Object.hasOwn(question.options, String(index)))) {
      throw new LearningError(422, "INVALID_OPTION_INDEX");
    }
    return saveCurrentResponse(database, activityId, input, mode, clock, draftMode);
  });
}

function requireQuestionVersion(activity: ReadingActivity, input: ChoiceDraftScope) {
  const question = activity.practice.questions.find(question => question.id === input.questionId);
  if (!question) throw new LearningError(422, "INVALID_QUESTION");
  if (question.version !== input.questionVersion) throw new LearningError(409, "QUESTION_REVISION_STALE");
  return question;
}

function saveCurrentResponse<Value extends StoredResponseValue>(
  database: DatabaseSync, activityId: string, input: DraftInput<Value>,
  mode: CurrentChoiceDraftMode, clock: () => Date, { schema, Conflict }: ResponseDraftMode<Value>,
) {
  const current = readQuestionDraftHead(database, activityId, input, schema);
  const previous = readQuestionDraftOperation(database, activityId, input, schema);
  if (previous && current) return publicDraft(replayResponseOperation(database, input, current, previous, Conflict));
  const state = current ?? { revision: 0, value: null };
  if (mode === "replayLatestOnly") throw new LearningError(409, "DRAFT_REPLAY_REQUIRED");
  if (state.revision !== input.baseRevision) throw new Conflict({ revision: state.revision, value: state.value });
  const written = current && sameStoredResponse(current.value, input.value) ? current : appendResponse(database, activityId, input, current, clock);
  rememberQuestionDraftOperation(database, input, written);
  return publicDraft(written);
}

type ResponseHead<Value extends StoredResponseValue> = NonNullable<ReturnType<typeof readQuestionDraftHead<DraftContent<Value>>>>;

function replayResponseOperation<Value extends StoredResponseValue>(
  database: DatabaseSync, input: DraftInput<Value>, current: ResponseHead<Value>,
  previous: { baseRevision: number; draft: DraftContent<Value> }, Conflict: ResponseDraftMode<Value>["Conflict"],
) {
  if (isLatestQuestionDraftOperation(database, current.workId, input.operationId)
    && previous.baseRevision === input.baseRevision && sameStoredResponse(previous.draft.value, input.value)) return current;
  throw new Conflict({ revision: current.revision, value: current.value }, "OPERATION_CONFLICT");
}

function appendResponse<Value>(
  database: DatabaseSync, activityId: string, input: DraftInput<Value>,
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
