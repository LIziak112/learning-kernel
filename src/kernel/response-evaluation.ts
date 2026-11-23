import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { VerdictResult } from "../contracts/evaluator.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import type { ResponseConfirmation } from "../contracts/response.ts";
import type { ReadingActivity } from "./activity.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

export function readResponseEvaluation(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ResponseConfirmation,
) {
  return readEvaluatedResponses(database, activity, receipt, confirmation.questions, assessmentTarget(database, activity.activityId));
}

export function readEvaluatedResponses(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt,
  confirmed: readonly { questionId: string; questionVersion: number }[], target: ReturnType<typeof assessmentTarget>,
) {
  const assessment = activity.practice.grading.assessment;
  if (!assessment || target?.submissionId !== receipt.id) throw new Error("已确认的原值评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status !== "done") return { status: target.status, evaluator };
  const outcomes = storedOutcomes(database, target);
  const questions = confirmed.map(({ questionId, questionVersion }) => {
    const result = outcomes.get(questionId);
    if (!result) throw new Error("已执行的原值评估缺少判定或待评事实");
    return { questionId, questionVersion, result };
  });
  return {
    status: "evaluated" as const, evaluator, questionCount: questions.length,
    correctCount: questions.filter(({ result }) => result.status === "judged" && result.correct).length,
    needsReviewCount: questions.filter(({ result }) => result.status === "needsReview").length, questions,
  };
}

export function recordResponseReviewRequirements(database: DatabaseSync, submissionId: string, questionIds: readonly string[]) {
  const requireReview = database.prepare(`
    INSERT INTO response_review_requirements (submission_id, question_id) VALUES (?, ?) ON CONFLICT DO NOTHING
  `);
  for (const questionId of questionIds) requireReview.run(submissionId, questionId);
}

const storedRequirement = z.strictObject({ questionId: z.string() });

export function readResponseReviewRequirements(database: DatabaseSync, submissionId: string) {
  return database.prepare("SELECT question_id AS questionId FROM response_review_requirements WHERE submission_id = ?")
    .all(submissionId).map(row => storedRequirement.parse(row).questionId);
}
function storedOutcomes(database: DatabaseSync, target: { submissionId: string; targetId: string }) {
  const outcomes = new Map<string, VerdictResult>();
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
