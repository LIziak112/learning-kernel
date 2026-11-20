import type { DatabaseSync } from "node:sqlite";
import type { ConfirmationKey } from "../contracts/choice-confirmation.ts";
import { questionDeliveryView, readQuestionDelivery } from "../contracts/question-delivery.ts";
import type { AuthorizeQuestionDeliveryReview, AuthorizeQuestionDeliveryVerdict, QuestionDelivery } from "../contracts/question-delivery.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import type { VerdictCommand } from "../contracts/verdict.ts";
import { loadActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { confirmedWorkForOperation } from "./question-confirmation.ts";
import { requireQuestionDeliverySlot } from "./question-delivery-drafts.ts";
import { readManualReviewBasis, readManualReviewQuestions } from "./question-delivery-evaluation.ts";
import { appendReview, repeatedReview } from "./verdict-history.ts";
import { questionVerdictStates, submissionAssessmentTarget } from "./verdict-state.ts";

export function readQuestionDeliveryReview(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeQuestionDeliveryReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content } = authorizedReview(database, reviewerId, activityId, key, authorize);
    const manualReview = activity.practice.grading.manualReview;
    if (!manualReview) throw new LearningError(404, "REVIEW_NOT_FOUND");
    const basis = readManualReviewBasis(database, receipt, manualReview.keyRef);
    const questions = readManualReviewQuestions(database, receipt, content);
    return { ...reviewedDelivery(activity, receipt, content), basis, questions };
  });
}

export function readQuestionDeliveryVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeQuestionDeliveryReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content } = authorizedReview(database, reviewerId, activityId, key, authorize);
    const target = requireAssessment(database, activity, receipt.id);
    const manualReview = activity.practice.grading.manualReview;
    const positions = content.questions.map(({ questionId, questionVersion }) => ({ questionId, questionVersion }));
    const states = questionVerdictStates(database, target, positions, "replace");
    const pending = !manualReview && target.status === "pending";
    const questions = states.map(({ questionId, questionVersion, revision, automatic, effective }) => {
      const state = { questionId, questionVersion, revision, ...automatic && { automatic } };
      if (effective) return { ...state, status: "judged" as const, effective };
      return { ...state, status: pending ? "pendingEvaluation" as const : "needsReview" as const };
    });
    const review = { ...reviewedDelivery(activity, receipt, content), targetId: target.targetId, questions };
    if (manualReview) return { ...review, assessment: "manual" as const, basis: readManualReviewBasis(database, receipt, manualReview.keyRef) };
    return { ...review, assessment: "automatic" as const };
  });
}

export function writeQuestionDeliveryVerdict(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, command: VerdictCommand,
  authorize: AuthorizeQuestionDeliveryVerdict | undefined, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const { activity, receipt, content, scope } = reviewConfirmation(database, reviewerId, activityId, key);
    const delivery = readQuestionDelivery(content);
    if (!delivery || command.submissionId !== receipt.id) throw new LearningError(403, "FORBIDDEN");
    const { targetId } = requireQuestionDeliverySlot(activity, delivery.slotId);
    const { questionId, action } = command;
    const question = delivery.questions.find(frozen => frozen.questionId === questionId);
    if (!question || command.targetId !== targetId) throw new LearningError(403, "FORBIDDEN");
    if (authorize?.({ ...scope, targetId, questionId, questionVersion: question.questionVersion, action }) !== true) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const target = requireAssessment(database, activity, receipt.id);
    if (target.targetId !== targetId) throw new Error("评估目标与冻结提交不一致");
    return repeatedReview(database, activityId, reviewerId, command)
      ?? appendReview(database, activityId, reviewerId, command, clock, "replace");
  });
}

function authorizedReview(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeQuestionDeliveryReview | undefined,
) {
  const recovered = reviewConfirmation(database, reviewerId, activityId, key);
  if (authorize?.(recovered.scope) !== true) throw new LearningError(403, "FORBIDDEN");
  const content = readQuestionDelivery(recovered.content);
  if (!content) throw new LearningError(404, "REVIEW_NOT_FOUND");
  return { ...recovered, content };
}

function reviewedDelivery({ practice: { id, version } }: ReadingActivity, receipt: SubmissionReceipt, content: QuestionDelivery) {
  return { receipt, practice: { id, version }, confirmation: questionDeliveryView(content) };
}

function requireAssessment(database: DatabaseSync, { practice: { grading } }: ReadingActivity, submissionId: string) {
  if (!grading.manualReview && !grading.assessment) throw new LearningError(404, "REVIEW_NOT_FOUND");
  const target = submissionAssessmentTarget(database, submissionId);
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
