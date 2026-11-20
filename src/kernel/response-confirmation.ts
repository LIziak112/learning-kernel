import type { DatabaseSync } from "node:sqlite";
import type { AuthorizeConfirmationRecovery, ConfirmationKey, VerifyOriginal } from "../contracts/choice-confirmation.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { readResponseConfirmation } from "../contracts/response.ts";
import type { ResponseConfirmationInput } from "../contracts/response.ts";
import type { ResponseEvaluatorRegistration } from "../contracts/response-evaluation.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import {
  confirmedDraftChangeCount, confirmedWorkForOperation, mapConfirmationQuestions, replayQuestionConfirmation, requireConfirmationRecovery,
  writeQuestionConfirmation,
} from "./question-confirmation.ts";
import { requireBeforeDeadline } from "./reading-progress.ts";
import { readResponseDrafts, ResponseDraftConflict, responseSlot } from "./response-drafts.ts";
import { recoverResponseEvaluation } from "./response-evaluation.ts";

export class ResponseConfirmationConflict extends ResponseDraftConflict {
  readonly questionId: string;

  constructor(questionId: string, current: ResponseDraftConflict["current"]) {
    super(current);
    this.questionId = questionId;
  }
}

export function confirmResponses(
  database: DatabaseSync, studentId: string, activityId: string, input: ResponseConfirmationInput,
  clock: () => Date, verifyOriginal?: VerifyOriginal,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    const previous = confirmedWorkForOperation(database, activityId, input);
    if (previous) {
      const intent = readResponseConfirmation(previous.content)?.questions.map(({ value, ...revision }) => revision);
      return replayQuestionConfirmation(previous.receipt, intent, input);
    }
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    const slot = responseSlot(activity, input.slotId);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const questions = freezeResponses(database, activity, input, slot.confirmFromDrafts.allowUnanswered);
    return writeQuestionConfirmation(database, activity, studentId, input, slot.targetId,
      { kind: "responseConfirmation", questions }, now, verifyOriginal);
  });
}

export function recoverResponseConfirmation(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey,
  authorize: AuthorizeConfirmationRecovery | undefined, registered: readonly ResponseEvaluatorRegistration[],
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, key.stepAttemptId);
    requireConfirmationRecovery({ studentId, activityId, stepAttemptId: key.stepAttemptId, operationId: key.operationId }, authorize);
    const previous = confirmedWorkForOperation(database, activityId, key);
    const confirmation = previous && readResponseConfirmation(previous.content);
    if (!previous || !confirmation) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
    const { receipt } = previous;
    const { id, version } = activity.practice;
    const evaluation = recoverResponseEvaluation(database, activity, receipt, confirmation, registered);
    const drafts = draftsOfResponses(database, activityId, receipt);
    const responseDraftChangeCounts = confirmation.questions.map(question => ({
      questionId: question.questionId, changeCount: confirmedDraftChangeCount(question, drafts.get(question.questionId), "value"),
    }));
    return { receipt, practice: { id, version }, confirmation, responseDraftChangeCounts, evaluation };
  });
}

function freezeResponses(database: DatabaseSync, activity: ReadingActivity, input: ResponseConfirmationInput, allowUnanswered: boolean) {
  const drafts = draftsOfResponses(database, activity.activityId, input);
  return mapConfirmationQuestions(activity, input.questions, requested => {
    const current = drafts.get(requested.questionId) ?? { revision: 0, value: null };
    if (requested.revision !== current.revision) {
      throw new ResponseConfirmationConflict(requested.questionId, { revision: current.revision, value: current.value });
    }
    if (current.value === null && !allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
    return { ...requested, value: current.value };
  });
}

function draftsOfResponses(database: DatabaseSync, activityId: string, { stepAttemptId, slotId }: Pick<SubmissionReceipt, "stepAttemptId" | "slotId">) {
  return new Map(readResponseDrafts(database, activityId, stepAttemptId).filter(draft => draft.slotId === slotId)
    .map(draft => [draft.questionId, draft]));
}
