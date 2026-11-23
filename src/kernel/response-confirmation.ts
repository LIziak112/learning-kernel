import type { DatabaseSync } from "node:sqlite";
import type { AuthorizeConfirmationRecovery, ConfirmationKey, VerifyOriginal } from "../contracts/choice-confirmation.ts";
import { LearningError } from "../contracts/learning-error.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { readResponseConfirmation } from "../contracts/response.ts";
import type { ResponseConfirmationInput } from "../contracts/response.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import {
  confirmedDraftChangeCount, confirmedWorkForOperation, mapConfirmationQuestions, replayQuestionConfirmation, requireConfirmationRecovery,
  writeQuestionConfirmation,
} from "./question-confirmation.ts";
import { requireBeforeDeadline } from "./reading-progress.ts";
import type { Registry } from "./registry.ts";
import { readResponseEvaluation } from "./response-evaluation.ts";
import { readResponseDrafts, ResponseDraftConflict, responseSlot } from "./response-drafts.ts";

export class ResponseConfirmationConflict extends ResponseDraftConflict {
  constructor(questionId: string, current: ResponseDraftConflict["current"]) {
    super(current, "ANSWER_REVISION_CONFLICT", questionId);
  }
}

export function confirmResponses(
  database: DatabaseSync, registry: Registry, studentId: string, activityId: string, input: ResponseConfirmationInput, clock: () => Date,
  verifyOriginal?: VerifyOriginal,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    const previous = confirmedWorkForOperation(database, activityId, input);
    if (previous) {
      const intent = readResponseConfirmation(previous.content)?.questions.map(({ value: _value, ...revision }) => revision);
      return replayQuestionConfirmation(previous.receipt, intent, input);
    }
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    const slot = responseSlot(registry, activity, input.slotId);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const type = registry.requireResponseType(slot.input);
    const drafts = draftsOfResponses(database, activityId, input);
    const answeredQuestionIds = new Set<string>();
    const questions = mapConfirmationQuestions(activity, input.questions, requested => {
      const current = drafts.get(requested.questionId) ?? { revision: 0, value: null };
      if (current.revision !== requested.revision) {
        throw new ResponseConfirmationConflict(requested.questionId, { revision: current.revision, value: current.value });
      }
      const question = activity.practice.questions.find(({ id }) => id === requested.questionId);
      if (question && current.value !== null && type.isAnswered(current.value, question)) answeredQuestionIds.add(requested.questionId);
      else if (!slot.confirmFromDrafts.allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
      return { ...requested, value: current.value };
    });
    return writeQuestionConfirmation(database, activity, studentId, input, slot.targetId, { kind: "responseConfirmation", questions }, now,
      verifyOriginal, { answeredQuestionIds });
  });
}

export function recoverResponseConfirmation(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmationRecovery | undefined,
) {
  return readTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, key.stepAttemptId);
    requireConfirmationRecovery({ studentId, activityId, stepAttemptId: key.stepAttemptId, operationId: key.operationId }, authorize);
    const previous = confirmedWorkForOperation(database, activityId, key);
    const confirmation = previous && readResponseConfirmation(previous.content);
    if (!previous || !confirmation) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
    const { receipt } = previous;
    const { id, version } = activity.practice;
    const evaluation = readResponseEvaluation(database, activity, receipt, confirmation);
    const drafts = draftsOfResponses(database, activityId, receipt);
    const responseDraftChangeCounts = confirmation.questions.map(question => ({
      questionId: question.questionId, changeCount: confirmedDraftChangeCount(question, drafts.get(question.questionId), "value"),
    }));
    return { receipt, practice: { id, version }, confirmation, responseDraftChangeCounts, evaluation };
  });
}

function draftsOfResponses(
  database: DatabaseSync, activityId: string, { stepAttemptId, slotId }: Pick<SubmissionReceipt, "stepAttemptId" | "slotId">,
) {
  return new Map(readResponseDrafts(database, activityId, stepAttemptId).filter(draft => draft.slotId === slotId)
    .map(draft => [draft.questionId, draft]));
}
