import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { VerdictResult } from "../contracts/evaluator.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { wholePaperScoringKey } from "../contracts/reading-publication.ts";
import type { ResponseConfirmation } from "../contracts/response.ts";
import type { ReadingActivity } from "./activity.ts";
import { loadEvaluationKey, recordEvaluation } from "./evaluation.ts";
import { evaluateFrozenAnswers, evaluationContext } from "./question-evaluation.ts";
import type { FrozenAnswer, QuestionKey } from "./question-evaluation.ts";
import { frozenResponseType, wholePaperQuestionKey } from "./question-types.ts";
import type { Registry } from "./registry.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

type PrepareKeys = (key: unknown) => QuestionKey;

export function responseEvaluation(database: DatabaseSync, registry: Registry) {
  return (activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ResponseConfirmation) => {
    const target = assessmentTarget(database, activity.activityId);
    return recoverEvaluatedResponses(database, registry, activity, receipt, confirmation.questions, stored => {
      const key = wholePaperScoringKey.parse(stored);
      return question => wholePaperQuestionKey(key, frozenResponseType(registry, activity.practice, question), question);
    }, target);
  };
}

export function recoverEvaluatedResponses(
  database: DatabaseSync, registry: Registry, activity: ReadingActivity, receipt: SubmissionReceipt, confirmed: readonly FrozenAnswer[],
  prepareKeys: PrepareKeys, target: ReturnType<typeof assessmentTarget>,
) {
  const assessment = activity.practice.grading.assessment;
  if (!assessment || target?.submissionId !== receipt.id) throw new Error("已确认的原值评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status === "pending") {
    const keyOf = prepareKeys(loadEvaluationKey(database, receipt.id));
    const outcomes = evaluateFrozenAnswers(registry, activity.practice, evaluator, evaluationContext(activity, receipt), confirmed, keyOf);
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
  outcomes: readonly { questionId: string; result: VerdictResult }[],
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
