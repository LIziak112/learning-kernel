import type { DatabaseSync } from "node:sqlite";
import { questionDeliveryReviewBasis } from "../contracts/question-delivery.ts";
import type { QuestionDelivery } from "../contracts/question-delivery.ts";
import type { SubmissionReceipt, VersionRef } from "../contracts/reading.ts";
import { LearningError } from "../contracts/learning-error.ts";
import type { ReadingActivity } from "./activity.ts";
import { loadEvaluationKey, queueEvaluation } from "./evaluation.ts";
import { readEvaluatedResponses, readResponseReviewRequirements, recordResponseReviewRequirements } from "./response-evaluation.ts";
import { submissionAssessmentTarget } from "./verdict-state.ts";

export function confirmedDeliveryAssessment(
  { practice: { grading: { assessment, manualReview, teacherReview } } }: Pick<ReadingActivity, "practice">, { questions }: QuestionDelivery,
) {
  const teacherIds = new Set(teacherReview?.questionIds);
  const review = manualReview ? questions : questions.filter(({ questionId }) => teacherIds.has(questionId));
  const automatic = assessment ? questions.filter(({ questionId }) => !teacherIds.has(questionId)) : [];
  return { automatic, review };
}

export function registerDeliveryAssessment(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, content: QuestionDelivery, targetId: string,
) {
  const { automatic, review } = confirmedDeliveryAssessment(activity, content);
  if (automatic.length || activity.practice.grading.manualReview) {
    queueEvaluation(database, activity, receipt, targetId, content.slotId);
  }
  if (review.length) recordResponseReviewRequirements(database, receipt.id, review.map(({ questionId }) => questionId));
}

export function recoverQuestionDeliveryAssessment(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, content: QuestionDelivery, mode: "automatic" | "declared",
) {
  const { automatic, review } = confirmedDeliveryAssessment(activity, content);
  if (automatic.length) {
    const evaluation = studentEvaluation(activity,
      readEvaluatedResponses(database, activity, receipt, automatic, submissionAssessmentTarget(database, receipt.id)));
    const questions = mode === "declared" && review.length > 0
      ? readManualReviewQuestions(database, receipt, review, true)
      : undefined;
    return { assessment: "automatic" as const, evaluation, ...questions && { review: { questions } } };
  }
  if (mode === "automatic") throw new LearningError(409, "ASSESSMENT_MODE_MISMATCH");
  if (review.length) {
    const questions = readManualReviewQuestions(database, receipt, review);
    if (activity.practice.grading.manualReview) return { assessment: "manual" as const, review: { questions } };
    return { assessment: "teacherReview" as const, review: { questions } };
  }
  return { assessment: "none" as const };
}

type Evaluation = ReturnType<typeof readEvaluatedResponses>;
type WithheldEvaluation = { [field in Exclude<keyof Extract<Evaluation, { status: "evaluated" }>, "status" | "evaluator">]?: never } & {
  status: "withheld"; evaluator: Evaluation["evaluator"];
};

function studentEvaluation(activity: ReadingActivity, evaluation: Evaluation): Evaluation | WithheldEvaluation {
  if (evaluation.status !== "evaluated" || !activity.practice.policy.student.passageScore) return evaluation;
  return { status: "withheld" as const, evaluator: evaluation.evaluator };
}

export function readManualReviewQuestions(
  database: DatabaseSync, receipt: SubmissionReceipt, questions: QuestionDelivery["questions"], mixed = false,
) {
  const required = new Set(readResponseReviewRequirements(database, receipt.id));
  if ((!mixed && required.size !== questions.length) || questions.some(({ questionId }) => !required.has(questionId))) {
    throw new Error("人工待评位置与冻结提交不一致");
  }
  return questions.map(({ questionId, questionVersion }) => ({ questionId, questionVersion, status: "needsReview" as const }));
}

export function readManualReviewBasis(database: DatabaseSync, receipt: SubmissionReceipt, reference: VersionRef) {
  const basis = questionDeliveryReviewBasis.parse(loadEvaluationKey(database, receipt.id));
  if (basis.id !== reference.id || basis.version !== reference.version) throw new Error("人工待评引用与冻结依据不一致");
  return basis;
}
