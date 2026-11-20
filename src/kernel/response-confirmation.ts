import type { DatabaseSync } from "node:sqlite";
import type { AuthorizeConfirmationRecovery, ConfirmationKey, VerifyOriginal } from "../contracts/choice-confirmation.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { hasStoredResponse, readIndexResponseConfirmation, readResponseConfirmation } from "../contracts/response.ts";
import type { IndexResponseConfirmation, ResponseConfirmation, ResponseConfirmationInput, ResponseValue, StoredResponseValue } from "../contracts/response.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import {
  confirmedDraftChangeCount, confirmedWorkForOperation, mapConfirmationQuestions, replayQuestionConfirmation, requireConfirmationRecovery,
  writeQuestionConfirmation,
} from "./question-confirmation.ts";
import { requireBeforeDeadline } from "./reading-progress.ts";
import { indexResponseDrafts, IndexResponseDraftConflict, readResponseDrafts, ResponseDraftConflict, responseSlot, scalarResponseDrafts } from "./response-drafts.ts";
import type { ResponseDraftMode } from "./response-drafts.ts";

export class ResponseConfirmationConflict extends ResponseDraftConflict {
  readonly questionId: string;
  constructor(questionId: string, current: ResponseDraftConflict["current"]) {
    super(current);
    this.questionId = questionId;
  }
}

type ConfirmedQuestion<Value> = ResponseConfirmationInput["questions"][number] & { value: Value | null };
type ResponseWork = ResponseConfirmation | IndexResponseConfirmation;
type ResponseMode<Value, Confirmation extends ResponseWork> = {
  drafts: ResponseDraftMode<Value>;
  read: (content: unknown) => Confirmation | undefined;
  content: (questions: ConfirmedQuestion<Value>[]) => Confirmation;
  conflict: (questionId: string, current: { revision: number; value: Value | null }) => LearningError;
};

export const scalarResponses: ResponseMode<ResponseValue, ResponseConfirmation> = {
  drafts: scalarResponseDrafts, read: readResponseConfirmation,
  conflict: (questionId, current) => new ResponseConfirmationConflict(questionId, current),
  content: questions => ({ kind: "responseConfirmation", questions }),
};
export const indexResponses: ResponseMode<number[], IndexResponseConfirmation> = {
  drafts: indexResponseDrafts, read: readIndexResponseConfirmation,
  conflict: (questionId, current) => new IndexResponseDraftConflict(current, "ANSWER_REVISION_CONFLICT", questionId),
  content: questions => ({ kind: "indexResponseConfirmation", questions }),
};

export function confirmResponses<Value extends StoredResponseValue, Confirmation extends ResponseWork>(
  database: DatabaseSync, studentId: string, activityId: string, input: ResponseConfirmationInput, clock: () => Date,
  mode: ResponseMode<Value, Confirmation>, verifyOriginal?: VerifyOriginal,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    const previous = confirmedWorkForOperation(database, activityId, input);
    if (previous) {
      const intent = mode.read(previous.content)?.questions.map(({ value, ...revision }) => revision);
      return replayQuestionConfirmation(previous.receipt, intent, input);
    }
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    const slot = responseSlot(activity, input.slotId, mode.drafts.format);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const questions = freezeResponses(database, activity, input, slot.confirmFromDrafts.allowUnanswered, mode);
    return writeQuestionConfirmation(database, activity, studentId, input, slot.targetId, mode.content(questions), now, verifyOriginal);
  });
}

export function recoverResponseConfirmation<Value extends StoredResponseValue, Confirmation extends ResponseWork, Result>(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey,
  authorize: AuthorizeConfirmationRecovery | undefined, mode: ResponseMode<Value, Confirmation>,
  evaluate: (activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: Confirmation) => Result,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, key.stepAttemptId);
    requireConfirmationRecovery({ studentId, activityId, stepAttemptId: key.stepAttemptId, operationId: key.operationId }, authorize);
    const previous = confirmedWorkForOperation(database, activityId, key);
    const confirmation = previous && mode.read(previous.content);
    if (!previous || !confirmation) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
    const { receipt } = previous;
    const { id, version } = activity.practice;
    const evaluation = evaluate(activity, receipt, confirmation);
    const drafts = draftsOfResponses(database, activityId, receipt, mode.drafts);
    const responseDraftChangeCounts = confirmation.questions.map(question => ({
      questionId: question.questionId, changeCount: confirmedDraftChangeCount(question, drafts.get(question.questionId), "value"),
    }));
    return { receipt, practice: { id, version }, confirmation, responseDraftChangeCounts, evaluation };
  });
}

function freezeResponses<Value extends StoredResponseValue, Confirmation extends ResponseWork>(
  database: DatabaseSync, activity: ReadingActivity, input: ResponseConfirmationInput, allowUnanswered: boolean,
  { drafts: draftMode, conflict }: ResponseMode<Value, Confirmation>,
) {
  const drafts = draftsOfResponses(database, activity.activityId, input, draftMode);
  return mapConfirmationQuestions(activity, input.questions, requested => {
    const current = drafts.get(requested.questionId) ?? { revision: 0, value: null };
    if (current.revision !== requested.revision) {
      throw conflict(requested.questionId, { revision: current.revision, value: current.value });
    }
    if (!hasStoredResponse(current.value) && !allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
    return { ...requested, value: current.value };
  });
}

function draftsOfResponses<Value extends StoredResponseValue>(
  database: DatabaseSync, activityId: string, { stepAttemptId, slotId }: Pick<SubmissionReceipt, "stepAttemptId" | "slotId">,
  mode: ResponseDraftMode<Value>,
) {
  return new Map(readResponseDrafts(database, activityId, stepAttemptId, mode).filter(draft => draft.slotId === slotId)
    .map(draft => [draft.questionId, draft]));
}
