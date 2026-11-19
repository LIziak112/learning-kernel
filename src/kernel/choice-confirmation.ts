import type { DatabaseSync } from "node:sqlite";
import { readChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmation, ChoiceConfirmationInput, ConfirmationKey,
  ConfirmationScope, VerifyOriginal } from "../contracts/choice-confirmation.ts";
import { loadStudentActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { ChoiceDraftConflict, readChoiceDrafts } from "./choice-drafts.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { boundOutput, requireBeforeDeadline } from "./reading-progress.ts";
import { finishActivity, recordSubmission, submissionForOperation } from "./submission-store.ts";
import { loadWorkVersion, saveWorkVersion } from "./work-versions.ts";

export class ChoiceConfirmationConflict extends ChoiceDraftConflict {
  readonly questionId: string;

  constructor(questionId: string, current: ChoiceDraftConflict["current"]) {
    super(current);
    this.questionId = questionId;
  }
}

type ConfirmedQuestion = ChoiceConfirmation["questions"][number];

export function confirmChoices(
  database: DatabaseSync, studentId: string, activityId: string, input: ChoiceConfirmationInput,
  clock: () => Date, verifyOriginal?: VerifyOriginal,
) {
  return writeTransaction(database, () => {
    const activity = loadChoiceActivity(database, studentId, activityId, input.stepAttemptId);
    const previous = confirmationForOperation(database, activityId, input);
    if (previous) return recoverReceipt(previous, input);
    const slot = requireConfirmationSlot(activity, input.slotId);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const questions = freezeAnswers(database, activity, input, slot.confirmFromDrafts.allowUnanswered);
    verifyOriginals(questions, { studentId, activityId, stepAttemptId: input.stepAttemptId, operationId: input.operationId },
      input.slotId, verifyOriginal);
    const content: ChoiceConfirmation = { kind: "choiceConfirmation", questions };
    const draft = saveWorkVersion(database, confirmationScope(activityId, input.stepAttemptId, input.slotId), content);
    const observations = questions.flatMap(({ questionId, choice }) =>
      choice === null ? [] : [{ targetId: slot.targetId, unitId: `question:${questionId}` }]);
    const receipt = recordSubmission(database, { ...input, draft }, observations, now);
    finishActivity(database, activityId, receipt.id);
    return receipt;
  });
}

export function recoverChoiceConfirmation(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey, authorize?: AuthorizeConfirmationRecovery,
) {
  return writeTransaction(database, () => {
    const { practice } = loadChoiceActivity(database, studentId, activityId, key.stepAttemptId);
    if (authorize?.({ studentId, activityId, stepAttemptId: key.stepAttemptId, operationId: key.operationId }) !== true) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const recovered = confirmationForOperation(database, activityId, key);
    if (!recovered?.confirmation) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
    return { receipt: recovered.receipt, practice: { id: practice.id, version: practice.version }, confirmation: recovered.confirmation };
  });
}

function loadChoiceActivity(database: DatabaseSync, studentId: string, activityId: string, stepAttemptId: string) {
  const activity = loadStudentActivity(database, studentId, activityId);
  if (activity.kind !== "reading" || activity.stepAttemptId !== stepAttemptId) throw new LearningError(403, "FORBIDDEN");
  return activity;
}

function requireConfirmationSlot(activity: ReadingActivity, slotId: string) {
  if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
  const slot = boundOutput(activity.step, slotId);
  if (slot.type !== "oneChoicePerQuestion" || !slot.confirmFromDrafts) throw new LearningError(422, "INVALID_SLOT");
  return { targetId: slot.targetId, confirmFromDrafts: slot.confirmFromDrafts };
}

function freezeAnswers(database: DatabaseSync, activity: ReadingActivity, input: ChoiceConfirmationInput, allowUnanswered: boolean) {
  const frozen = activity.practice.questions;
  const selected = new Map(input.questions.map(question => [question.questionId, question]));
  if (selected.size !== frozen.length || selected.size !== input.questions.length) {
    throw new LearningError(422, "INVALID_QUESTION_SET");
  }
  const drafts = new Map(readChoiceDrafts(database, activity.activityId, activity.stepAttemptId)
    .filter(draft => draft.slotId === input.slotId).map(draft => [draft.questionId, draft]));
  return frozen.map(question => {
    const requested = selected.get(question.id);
    if (!requested) throw new LearningError(422, "INVALID_QUESTION_SET");
    if (requested.questionVersion !== question.version) throw new LearningError(409, "QUESTION_REVISION_STALE");
    const current = drafts.get(question.id) ?? { revision: 0, choice: null };
    if (requested.revision !== current.revision) {
      throw new ChoiceConfirmationConflict(question.id, { revision: current.revision, choice: current.choice });
    }
    if (current.choice === null && !allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
    return { ...requested, choice: current.choice };
  });
}

function verifyOriginals(questions: ConfirmedQuestion[], scope: ConfirmationScope, slotId: string, verify?: VerifyOriginal) {
  for (const { questionId, questionVersion, original } of questions) {
    if (!verify && original.state === "uncollected") continue;
    if (verify?.({ ...scope, slotId, questionId, questionVersion, original: { ...original } }) !== true) {
      throw new LearningError(409, "ORIGINAL_NOT_VERIFIED");
    }
  }
}

function confirmationScope(activityId: string, stepAttemptId: string, slotId: string) {
  return { activityId, step: { id: stepAttemptId, slotId } };
}

function confirmationForOperation(database: DatabaseSync, activityId: string, input: ConfirmationKey) {
  const previous = submissionForOperation(database, input);
  if (!previous) return undefined;
  const { receipt, draft } = previous;
  const content = loadWorkVersion(database, confirmationScope(activityId, receipt.stepAttemptId, receipt.slotId), draft);
  return { receipt, confirmation: readChoiceConfirmation(content) };
}

function recoverReceipt(previous: NonNullable<ReturnType<typeof confirmationForOperation>>, input: ChoiceConfirmationInput) {
  const { receipt, confirmation } = previous;
  const intent = confirmation?.questions.map(({ choice, ...selection }) => selection);
  if (receipt.slotId !== input.slotId || !intent
    || questionIntent(intent) !== questionIntent(input.questions)) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return receipt;
}

function questionIntent(questions: ChoiceConfirmationInput["questions"]) {
  return JSON.stringify(questions.toSorted((a, b) => a.questionId === b.questionId ? 0 : a.questionId < b.questionId ? -1 : 1));
}
