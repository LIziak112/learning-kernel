import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { responseScoringKeySchema } from "../contracts/reading-publication.ts";
import { findResponseEvaluator, responseVerdict } from "../contracts/response-evaluation.ts";
import type { ResponseEvaluator, ResponseEvaluatorRegistration, ResponseVerdict } from "../contracts/response-evaluation.ts";
import type { ResponseConfirmation } from "../contracts/response.ts";
import type { ReadingActivity } from "./activity.ts";
import { loadEvaluationKey, recordEvaluation } from "./evaluation.ts";
import { LearningError } from "./learning-error.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

export function recoverResponseEvaluation(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ResponseConfirmation,
  registered: readonly ResponseEvaluatorRegistration[],
) {
  const assessment = activity.practice.grading.assessment;
  const target = assessmentTarget(database, activity.activityId);
  if (!assessment || target?.submissionId !== receipt.id) throw new Error("已确认的原值评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status === "pending") {
    const evaluate = findResponseEvaluator(registered, evaluator);
    if (!evaluate) throw new LearningError(503, "EVALUATOR_UNAVAILABLE");
    completeResponseEvaluation(database, activity, receipt, target, confirmation, evaluate);
  }
  const outcomes = storedOutcomes(database, target);
  const questions = confirmation.questions.map(({ questionId, questionVersion }) => {
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
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, target: { submissionId: string; targetId: string },
  confirmation: ResponseConfirmation, evaluate: ResponseEvaluator,
) {
  const { acceptedResponses } = responseScoringKeySchema.parse(loadEvaluationKey(database, receipt.id));
  const { id, version } = activity.practice;
  const outcomes = confirmation.questions.map(({ questionId, questionVersion, value }) => {
    const acceptedResponse = acceptedResponses[questionId];
    if (typeof acceptedResponse !== "boolean") throw new Error("冻结的原值评分键缺少题目");
    const result = responseVerdict.parse(evaluate({
      activityId: activity.activityId, stepAttemptId: receipt.stepAttemptId, slotId: receipt.slotId,
      practice: { id, version }, questionId, questionVersion, value, acceptedResponse,
    }));
    return { questionId, result };
  });
  const requireReview = database.prepare("INSERT INTO response_review_requirements (submission_id, question_id) VALUES (?, ?)");
  const judged = outcomes.flatMap(({ questionId, result }) => {
    if (result.status === "judged") return [{ questionId, correct: result.correct }];
    requireReview.run(receipt.id, questionId);
    return [];
  });
  recordEvaluation(database, target, judged);
}

const storedRequirement = z.strictObject({ questionId: z.string() });
function storedOutcomes(database: DatabaseSync, target: { submissionId: string; targetId: string }) {
  const outcomes = new Map<string, ResponseVerdict>();
  for (const { questionId, correct, valid } of readAutomaticVerdicts(database, target)) {
    if (!valid) throw new Error("已执行的原值评估包含无效自动判定");
    outcomes.set(questionId, { status: "judged", correct });
  }
  const pending = database.prepare("SELECT question_id AS questionId FROM response_review_requirements WHERE submission_id = ?").all(target.submissionId);
  for (const row of pending) {
    const { questionId } = storedRequirement.parse(row);
    if (outcomes.has(questionId)) throw new Error("同一道题同时处于已评与待评");
    outcomes.set(questionId, { status: "needsReview" });
  }
  return outcomes;
}
