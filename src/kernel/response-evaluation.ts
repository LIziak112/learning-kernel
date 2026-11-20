import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SubmissionReceipt, VersionRef } from "../contracts/reading.ts";
import { indexResponseScoringKeySchema, responseScoringKeySchema } from "../contracts/reading-publication.ts";
import { findResponseEvaluator, responseVerdict } from "../contracts/response-evaluation.ts";
import type { IndexResponseEvaluatorRegistration, ResponseEvaluationInput, ResponseEvaluatorRegistration, ResponseVerdict } from "../contracts/response-evaluation.ts";
import type { IndexResponseConfirmation, ResponseConfirmation, StoredResponseValue } from "../contracts/response.ts";
import type { ReadingActivity } from "./activity.ts";
import { loadEvaluationKey, recordEvaluation } from "./evaluation.ts";
import { LearningError } from "./learning-error.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

export type EvaluationQuestion<Value> = { questionId: string; questionVersion: number; value: Value | null };
type EvaluationContext = Omit<ResponseEvaluationInput, keyof EvaluationQuestion<StoredResponseValue> | "acceptedResponse">;
type PrepareEvaluation<Value> = (ref: VersionRef, key: unknown, context: EvaluationContext) => (question: EvaluationQuestion<Value>) => ResponseVerdict;

export function scalarResponseEvaluation(database: DatabaseSync, registered: readonly ResponseEvaluatorRegistration[]) {
  return (activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ResponseConfirmation) =>
    recoverResponseEvaluation(database, activity, receipt, confirmation.questions, (ref, key, context) => {
      const evaluate = requireEvaluator(registered, ref);
      const { acceptedResponses } = responseScoringKeySchema.parse(key);
      return question => {
        const acceptedResponse = acceptedResponses[question.questionId];
        if (typeof acceptedResponse !== "boolean") throw new Error("冻结的原值评分键缺少题目");
        return evaluate({ ...context, practice: { ...context.practice }, ...question, acceptedResponse });
      };
    });
}

export function indexResponseEvaluation(database: DatabaseSync, registered: readonly IndexResponseEvaluatorRegistration[]) {
  return (activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: IndexResponseConfirmation) =>
    recoverResponseEvaluation(database, activity, receipt, confirmation.questions, (ref, key, context) => {
      const evaluate = requireEvaluator(registered, ref);
      const { acceptedIndexes } = indexResponseScoringKeySchema.parse(key);
      return question => {
        const correctIndexes = acceptedIndexes[question.questionId];
        if (!correctIndexes) throw new Error("冻结的索引评分键缺少题目");
        return evaluate({
          ...context, practice: { ...context.practice }, ...question,
          value: question.value?.slice() ?? null, acceptedIndexes: [...correctIndexes],
        });
      };
    });
}

function requireEvaluator<T extends VersionRef & { evaluate: unknown }>(registered: readonly T[], ref: VersionRef) {
  const evaluate = findResponseEvaluator(registered, ref);
  if (!evaluate) throw new LearningError(503, "EVALUATOR_UNAVAILABLE");
  return evaluate;
}

function recoverResponseEvaluation<Value extends StoredResponseValue>(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, confirmed: readonly EvaluationQuestion<Value>[],
  prepareEvaluation: PrepareEvaluation<Value>,
) {
  const target = assessmentTarget(database, activity.activityId);
  return recoverEvaluatedResponses(database, activity, receipt, confirmed, prepareEvaluation, target);
}

export function recoverEvaluatedResponses<Value extends StoredResponseValue>(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, confirmed: readonly EvaluationQuestion<Value>[],
  prepareEvaluation: PrepareEvaluation<Value>, target: ReturnType<typeof assessmentTarget>,
) {
  const assessment = activity.practice.grading.assessment;
  if (!assessment || target?.submissionId !== receipt.id) throw new Error("已确认的原值评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status === "pending") {
    const { id, version } = activity.practice;
    const evaluate = prepareEvaluation(evaluator, loadEvaluationKey(database, receipt.id), {
      activityId: activity.activityId, stepAttemptId: receipt.stepAttemptId, slotId: receipt.slotId, practice: { id, version },
    });
    const outcomes = confirmed.map(({ questionId, questionVersion, value }) => ({
      questionId, result: responseVerdict.parse(evaluate({ questionId, questionVersion, value })),
    }));
    completeResponseEvaluation(database, target, outcomes);
  }
  const outcomes = storedOutcomes(database, target);
  const questions = confirmed.map(({ questionId, questionVersion }) => {
    const result = outcomes.get(questionId);
    if (!result) throw new Error("已执行的原值评估缺少判定或待评事实");
    return { questionId, questionVersion, result };
  });
  return {
    evaluator, questionCount: questions.length,
    correctCount: questions.filter(({ result }) => result.status === "judged" && result.correct).length,
    needsReviewCount: questions.filter(({ result }) => result.status === "needsReview").length, questions,
  };
}

function completeResponseEvaluation(
  database: DatabaseSync, target: { submissionId: string; targetId: string },
  outcomes: readonly { questionId: string; result: ResponseVerdict }[],
) {
  const pending: string[] = [];
  const judged = outcomes.flatMap(({ questionId, result }) => {
    if (result.status === "judged") return [{ questionId, correct: result.correct }];
    pending.push(questionId);
    return [];
  });
  recordResponseReviewRequirements(database, target.submissionId, pending);
  recordEvaluation(database, target, judged);
}

export function recordResponseReviewRequirements(database: DatabaseSync, submissionId: string, questionIds: readonly string[]) {
  const requireReview = database.prepare("INSERT INTO response_review_requirements (submission_id, question_id) VALUES (?, ?)");
  for (const questionId of questionIds) requireReview.run(submissionId, questionId);
}

const storedRequirement = z.strictObject({ questionId: z.string() });

export function readResponseReviewRequirements(database: DatabaseSync, submissionId: string) {
  return database.prepare("SELECT question_id AS questionId FROM response_review_requirements WHERE submission_id = ?")
    .all(submissionId).map(row => storedRequirement.parse(row).questionId);
}
function storedOutcomes(database: DatabaseSync, target: { submissionId: string; targetId: string }) {
  const outcomes = new Map<string, ResponseVerdict>();
  for (const { questionId, correct, valid } of readAutomaticVerdicts(database, target)) {
    if (!valid) throw new Error("已执行的原值评估包含无效自动判定");
    outcomes.set(questionId, { status: "judged", correct });
  }
  for (const questionId of readResponseReviewRequirements(database, target.submissionId)) {
    if (outcomes.has(questionId)) throw new Error("同一道题同时处于已评与待评");
    outcomes.set(questionId, { status: "needsReview" });
  }
  return outcomes;
}
