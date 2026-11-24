import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ChoiceDraftScope, CurrentChoiceDraftMode } from "../contracts/choice-draft.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { responseDraftValue, responseValue } from "../contracts/response.ts";
import type { ResponseDraftInput, ResponseDraftRequest, ResponseValue } from "../contracts/response.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { recordChoiceDraftChange } from "./choice-draft-activity.ts";
import { choiceRevisionBeforeAnswers } from "./choice-snapshot-store.ts";
import { writeTransaction } from "./database.ts";
import {
  isLatestQuestionDraftOperation, publicDraft, QuestionDraftConflict, readQuestionDraftHead, readQuestionDraftOperation,
  readQuestionDrafts, rememberQuestionDraftOperation,
} from "./question-draft-store.ts";
import { writableOutput } from "./reading-progress.ts";
import type { Registry } from "./registry.ts";
import { saveWorkVersion } from "./work-versions.ts";

type DraftState = { revision: number; value: ResponseValue | null };

export class ResponseDraftConflict extends QuestionDraftConflict<DraftState> {
  readonly questionId: string | undefined;

  constructor(current: DraftState, code?: "ANSWER_REVISION_CONFLICT" | "OPERATION_CONFLICT", questionId?: string) {
    super(current, code);
    this.questionId = questionId;
  }
}

type DraftConflict = new (current: DraftState, code?: "ANSWER_REVISION_CONFLICT" | "OPERATION_CONFLICT") => LearningError;

export function responseSlot(registry: Registry, activity: ReadingActivity, slotId: string) {
  const slot = writableOutput(registry, activity.step, slotId);
  if (slot.type !== "oneResponsePerQuestion") throw new LearningError(422, "INVALID_SLOT");
  return slot;
}

export function readResponseDrafts(database: DatabaseSync, activityId: string, stepAttemptId: string) {
  return readQuestionDrafts(database, activityId, stepAttemptId, responseDraftValue);
}

export function saveResponseDraft(
  database: DatabaseSync, registry: Registry, studentId: string, activityId: string, input: ResponseDraftRequest,
  mode: CurrentChoiceDraftMode, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    const slot = responseSlot(registry, activity, input.slotId);
    const question = requireQuestionVersion(activity, input);
    const value = responseValue.parse(registry.requireResponseType(slot.input).parseValue(input.value, question));
    return saveCurrentResponse(database, activityId, { ...input, value }, mode, clock, ResponseDraftConflict);
  });
}

function requireQuestionVersion(activity: ReadingActivity, input: ChoiceDraftScope) {
  const question = activity.practice.questions.find(question => question.id === input.questionId);
  if (!question) throw new LearningError(422, "INVALID_QUESTION");
  if (question.version !== input.questionVersion) throw new LearningError(409, "QUESTION_REVISION_STALE");
  return question;
}

export function saveCurrentResponse(
  database: DatabaseSync, activityId: string, input: ResponseDraftInput, mode: CurrentChoiceDraftMode, clock: () => Date,
  Conflict: DraftConflict,
) {
  const current = readQuestionDraftHead(database, activityId, input, responseDraftValue);
  const previous = readQuestionDraftOperation(database, activityId, input, responseDraftValue);
  if (previous && current) {
    if (isLatestQuestionDraftOperation(database, current.workId, input.operationId)
      && previous.baseRevision === input.baseRevision && isDeepStrictEqual(previous.draft.value, input.value)) return publicDraft(current);
    throw new Conflict({ revision: current.revision, value: current.value }, "OPERATION_CONFLICT");
  }
  const state = current ?? { revision: choiceRevisionBeforeAnswers(database, input), value: null };
  if (mode === "replayLatestOnly") throw new LearningError(409, "DRAFT_REPLAY_REQUIRED");
  if (state.revision !== input.baseRevision) throw new Conflict({ revision: state.revision, value: state.value });
  const written = current && isDeepStrictEqual(current.value, input.value) ? current
    : appendResponse(database, activityId, input, current ?? { revision: state.revision }, clock);
  rememberQuestionDraftOperation(database, input, written);
  return publicDraft(written);
}

function appendResponse(
  database: DatabaseSync, activityId: string, input: ResponseDraftInput,
  current: { workId?: string; revision: number; changeCount?: number }, clock: () => Date,
) {
  const { stepAttemptId, slotId, questionId, questionVersion, value } = input;
  recordChoiceDraftChange(database, activityId, clock());
  const draft = saveWorkVersion(database, { activityId, step: { id: stepAttemptId, slotId, questionId } },
    { questionVersion, value }, current.workId);
  return {
    workId: draft.id, workVersion: draft.version, slotId, questionId, questionVersion, value,
    revision: current.revision + 1, changeCount: (current.changeCount ?? 0) + 1,
  };
}
