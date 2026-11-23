import type { DatabaseSync } from "node:sqlite";
import { readChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { ChoiceConfirmationInput, ConfirmationKey } from "../contracts/choice-confirmation.ts";
import { questionDeliveryView, readQuestionDelivery } from "../contracts/question-delivery.ts";
import type { QuestionDelivery } from "../contracts/question-delivery.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { readResponseConfirmation } from "../contracts/response.ts";
import type { AuthorizeConfirmedReview, AuthorizeConfirmedVerdict, FrozenConfirmationVerdictMode, VerdictCommand } from "../contracts/verdict.ts";
import { loadActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { confirmedWorkForOperation } from "./question-confirmation.ts";
import { requireQuestionDeliverySlot } from "./question-delivery-drafts.ts";
import { confirmedDeliveryAssessment, readManualReviewBasis, readManualReviewQuestions } from "./question-delivery-evaluation.ts";
import { boundOutput } from "./reading-progress.ts";
import { appendReview, repeatedReview } from "./verdict-history.ts";
import { questionVerdictStates, submissionReviewTarget } from "./verdict-state.ts";

export function readQuestionDeliveryReview(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content } = authorizedReview(database, reviewerId, activityId, key, authorize);
    const manualReview = activity.practice.grading.manualReview;
    if (!manualReview) throw new LearningError(404, "REVIEW_NOT_FOUND");
    const basis = readManualReviewBasis(database, receipt, manualReview.keyRef);
    const questions = readManualReviewQuestions(database, receipt, content.questions);
    return { ...reviewedDelivery(activity, receipt, content), basis, questions };
  });
}

export function readQuestionDeliveryVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content } = authorizedReview(database, reviewerId, activityId, key, authorize);
    const target = requireAssessment(database, receipt.id, requireQuestionDeliverySlot(activity, content.slotId).targetId);
    const manualReview = activity.practice.grading.manualReview;
    const { automatic, review } = confirmedDeliveryAssessment(activity, content);
    const assessmentIds = new Set([...automatic, ...review].map(({ questionId }) => questionId));
    const confirmed = content.questions.filter(({ questionId }) => assessmentIds.has(questionId));
    const questions = reviewedVerdicts(database, target, confirmed, automatic);
    const reviewed = { ...reviewedDelivery(activity, receipt, { ...content, questions: confirmed }), targetId: target.targetId, questions };
    if (manualReview) return { ...reviewed, assessment: "manual" as const, basis: readManualReviewBasis(database, receipt, manualReview.keyRef) };
    if (automatic.length) return { ...reviewed, assessment: "automatic" as const };
    return { ...reviewed, assessment: "teacherReview" as const };
  });
}

export function readChoiceConfirmationVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
) {
  return readFrozenConfirmationVerdicts(database, reviewerId, activityId, key, authorize, readChoiceConfirmation);
}

export function readResponseConfirmationVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
) {
  return readFrozenConfirmationVerdicts(database, reviewerId, activityId, key, authorize, readResponseConfirmation);
}

function readFrozenConfirmationVerdicts<Confirmation extends Pick<ChoiceConfirmationInput, "questions">>(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
  read: (content: unknown) => Confirmation | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content } = authorizedConfirmation(database, reviewerId, activityId, key, authorize);
    const confirmation = read(content);
    if (!confirmation) throw new LearningError(404, "REVIEW_NOT_FOUND");
    const target = requireAssessment(database, receipt.id, boundOutput(activity.step, receipt.slotId).targetId);
    const questions = reviewedVerdicts(database, target, confirmation.questions, confirmation.questions);
    const { id, version } = activity.practice;
    return { receipt, practice: { id, version }, confirmation, targetId: target.targetId, assessment: "automatic" as const, questions };
  });
}

function reviewedVerdicts(
  database: DatabaseSync, target: ReturnType<typeof requireAssessment>,
  positions: readonly { questionId: string; questionVersion: number }[], automatic: readonly { questionId: string }[],
) {
  const states = questionVerdictStates(database, target, positions);
  const pending = new Set(target.status === "pending" ? automatic.map(({ questionId }) => questionId) : []);
  return states.map(({ questionId, questionVersion, revision, automatic, effective }) => {
    const state = { questionId, questionVersion, revision, ...automatic && { automatic } };
    if (effective) return { ...state, status: "judged" as const, effective };
    return { ...state, status: pending.has(questionId) ? "pendingEvaluation" as const : "needsReview" as const };
  });
}

export function writeQuestionDeliveryVerdict(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, command: VerdictCommand,
  authorize: AuthorizeConfirmedVerdict | undefined, clock: () => Date, mode?: FrozenConfirmationVerdictMode,
) {
  return writeTransaction(database, () => {
    const { activity, receipt, content, scope } = reviewConfirmation(database, reviewerId, activityId, key);
    const { delivery, questionVersion, targetId } = requireVerdictPosition(activity, receipt, content, command, mode);
    const { questionId, action } = command;
    if (authorize?.({ ...scope, targetId, questionId, questionVersion, action }) !== true) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const target = requireAssessment(database, receipt.id, targetId);
    if (target.targetId !== targetId) throw new Error("评估目标与冻结提交不一致");
    if (delivery) {
      const { automatic, review } = confirmedDeliveryAssessment(activity, delivery);
      if (![...automatic, ...review].some(question => question.questionId === questionId)) throw new LearningError(403, "FORBIDDEN");
    }
    return repeatedReview(database, activityId, reviewerId, command)
      ?? appendReview(database, activityId, reviewerId, command, clock);
  });
}

function requireVerdictPosition(
  activity: ReadingActivity, receipt: SubmissionReceipt, content: unknown, command: VerdictCommand, mode: FrozenConfirmationVerdictMode | undefined,
) {
  const delivery = mode === undefined ? readQuestionDelivery(content) : undefined;
  const confirmation = mode === "responseConfirmation" ? readResponseConfirmation(content)
    : mode === "choiceConfirmation" ? readChoiceConfirmation(content) : delivery;
  if (!confirmation || command.submissionId !== receipt.id) throw new LearningError(403, "FORBIDDEN");
  const slot = delivery ? requireQuestionDeliverySlot(activity, delivery.slotId) : boundOutput(activity.step, receipt.slotId);
  const question = confirmation.questions.find(frozen => frozen.questionId === command.questionId);
  if (!question || command.targetId !== slot.targetId) throw new LearningError(403, "FORBIDDEN");
  return { delivery, questionVersion: question.questionVersion, targetId: slot.targetId };
}

function authorizedReview(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
) {
  const recovered = authorizedConfirmation(database, reviewerId, activityId, key, authorize);
  const content = readQuestionDelivery(recovered.content);
  if (!content) throw new LearningError(404, "REVIEW_NOT_FOUND");
  return { ...recovered, content };
}

function authorizedConfirmation(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeConfirmedReview | undefined,
) {
  const recovered = reviewConfirmation(database, reviewerId, activityId, key);
  if (authorize?.(recovered.scope) !== true) throw new LearningError(403, "FORBIDDEN");
  return recovered;
}

function reviewedDelivery({ practice: { id, version } }: ReadingActivity, receipt: SubmissionReceipt, content: QuestionDelivery) {
  return { receipt, practice: { id, version }, confirmation: questionDeliveryView(content) };
}

function requireAssessment(database: DatabaseSync, submissionId: string, targetId: string) {
  const target = submissionReviewTarget(database, submissionId, targetId);
  if (!target) throw new LearningError(404, "REVIEW_NOT_FOUND");
  return target;
}

function reviewConfirmation(database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey) {
  const { stepAttemptId, operationId } = key;
  const studentId = database.prepare(`
    SELECT a.student_id AS studentId FROM activities a
    JOIN step_attempts t ON t.activity_id = a.id
    LEFT JOIN reading_reviews r ON r.activity_id = a.id
    WHERE a.id = ? AND t.id = ? AND (r.activity_id IS NULL OR (r.reviewer_id = ? AND r.reviewer_active = 1))
  `).get(activityId, stepAttemptId, reviewerId)?.studentId;
  if (typeof studentId !== "string") throw new LearningError(403, "FORBIDDEN");
  const activity = loadActivity(database, studentId, activityId);
  if (activity.kind !== "reading" || activity.stepAttemptId !== stepAttemptId) throw new LearningError(403, "FORBIDDEN");
  const recovered = confirmedWorkForOperation(database, activityId, key);
  if (!recovered) throw new LearningError(403, "FORBIDDEN");
  const { id: submissionId, slotId } = recovered.receipt;
  const scope = { reviewerId, studentId, activityId, stepAttemptId, operationId, submissionId, slotId };
  return { activity, ...recovered, scope };
}
