import type { DatabaseSync } from "node:sqlite";
import { readChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey,
  VerifyOriginal } from "../contracts/choice-confirmation.ts";
import type { ChoiceEvaluatorRegistration } from "../contracts/choice-evaluation.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { ChoiceDraftConflict, readChoiceDrafts } from "./choice-drafts.ts";
import { recoverChoiceEvaluation } from "./choice-evaluation.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { boundOutput, requireBeforeDeadline } from "./reading-progress.ts";
import {
  confirmedDraftChangeCount, confirmedWorkForOperation, mapConfirmationQuestions, replayQuestionConfirmation, requireConfirmationRecovery,
  writeQuestionConfirmation,
} from "./question-confirmation.ts";

export class ChoiceConfirmationConflict extends ChoiceDraftConflict {
  readonly questionId: string;

  constructor(questionId: string, current: ChoiceDraftConflict["current"]) {
    super(current);
    this.questionId = questionId;
  }
}

export function confirmChoices(
  database: DatabaseSync, studentId: string, activityId: string, input: ChoiceConfirmationInput,
  clock: () => Date, verifyOriginal?: VerifyOriginal,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    const previous = confirmationForOperation(database, activityId, input);
    if (previous) {
      const intent = previous.confirmation?.questions.map(({ choice, ...revision }) => revision);
      return replayQuestionConfirmation(previous.receipt, intent, input);
    }
    const slot = requireConfirmationSlot(activity, input.slotId);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const questions = freezeAnswers(database, activity, input, slot.confirmFromDrafts.allowUnanswered);
    return writeQuestionConfirmation(database, activity, studentId, input, slot.targetId, { kind: "choiceConfirmation", questions }, now, verifyOriginal);
  });
}

export function recoverChoiceConfirmation(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey,
  authorize: AuthorizeConfirmationRecovery | undefined, registered: readonly ChoiceEvaluatorRegistration[],
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, key.stepAttemptId);
    requireConfirmationRecovery({ studentId, activityId, stepAttemptId: key.stepAttemptId, operationId: key.operationId }, authorize);
    const recovered = confirmationForOperation(database, activityId, key);
    if (!recovered?.confirmation) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
    const { receipt, confirmation } = recovered;
    const { id, version } = activity.practice;
    const evaluation = recoverChoiceEvaluation(database, activity, receipt, confirmation, registered);
    const drafts = draftsByQuestion(database, activityId, receipt);
    const choiceDraftChangeCounts = confirmation.questions.map(question => ({
      questionId: question.questionId, changeCount: confirmedDraftChangeCount(question, drafts.get(question.questionId), "choice"),
    }));
    return { receipt, practice: { id, version }, confirmation, choiceDraftChangeCounts, ...(evaluation ? { evaluation } : {}) };
  });
}

function requireConfirmationSlot(activity: ReadingActivity, slotId: string) {
  if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
  const slot = boundOutput(activity.step, slotId);
  if (slot.type !== "oneChoicePerQuestion" || !slot.confirmFromDrafts) throw new LearningError(422, "INVALID_SLOT");
  return { targetId: slot.targetId, confirmFromDrafts: slot.confirmFromDrafts };
}

function freezeAnswers(database: DatabaseSync, activity: ReadingActivity, input: ChoiceConfirmationInput, allowUnanswered: boolean) {
  const heads = confirmationHeads(database, activity, input);
  return mapConfirmationQuestions(activity, input.questions, requested => {
    const current = heads.get(requested.questionId) ?? { revision: 0, choice: null };
    if (requested.revision !== current.revision) {
      throw new ChoiceConfirmationConflict(requested.questionId, { revision: current.revision, choice: current.choice });
    }
    if (current.choice === null && !allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
    return { ...requested, choice: current.choice };
  });
}

function confirmationHeads(database: DatabaseSync, activity: ReadingActivity, input: ChoiceConfirmationInput) {
  const heads = new Map<string, ChoiceDraftConflict["current"]>();
  for (const { slotId, questionId, revision } of activity.choiceSnapshotRevisions) {
    if (slotId === input.slotId) heads.set(questionId, { revision, choice: null });
  }
  for (const [questionId, draft] of draftsByQuestion(database, activity.activityId, input)) {
    heads.set(questionId, draft);
  }
  return heads;
}

function draftsByQuestion(database: DatabaseSync, activityId: string, { stepAttemptId, slotId }: Pick<SubmissionReceipt, "stepAttemptId" | "slotId">) {
  return new Map(readChoiceDrafts(database, activityId, stepAttemptId)
    .filter(draft => draft.slotId === slotId).map(draft => [draft.questionId, draft]));
}

function confirmationForOperation(database: DatabaseSync, activityId: string, input: ConfirmationKey) {
  const previous = confirmedWorkForOperation(database, activityId, input);
  return previous && { receipt: previous.receipt, confirmation: readChoiceConfirmation(previous.content) };
}
