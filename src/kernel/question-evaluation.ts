import { verdictResult } from "../contracts/evaluator.ts";
import type { EvaluationContext, VerdictResult } from "../contracts/evaluator.ts";
import { LearningError } from "../contracts/learning-error.ts";
import type { VersionRef } from "../contracts/reading.ts";
import type { ReadingActivity } from "./activity.ts";
import { frozenResponseType } from "./question-types.ts";
import type { Registry } from "./registry.ts";

type Question = ReadingActivity["practice"]["questions"][number];
export type FrozenAnswer = { questionId: string; questionVersion: number; value: unknown };
export type QuestionKey = (question: Question) => unknown;

export function evaluationContext(activity: ReadingActivity, receipt: { stepAttemptId: string; slotId: string }): EvaluationContext {
  const { id, version } = activity.practice;
  return { activityId: activity.activityId, stepAttemptId: receipt.stepAttemptId, slotId: receipt.slotId, practice: { id, version } };
}

export function evaluateFrozenAnswers(
  registry: Registry, practice: ReadingActivity["practice"], reference: VersionRef, context: EvaluationContext,
  answers: readonly FrozenAnswer[], keyOf: QuestionKey,
): { questionId: string; result: VerdictResult }[] {
  const evaluator = registry.evaluator(reference);
  if (!evaluator) throw new LearningError(503, "EVALUATOR_UNAVAILABLE");
  return answers.map(({ questionId, questionVersion, value }) => {
    const question = practice.questions.find(({ id }) => id === questionId);
    if (!question) throw new Error("冻结的作答缺少对应题目");
    const type = frozenResponseType(registry, practice, question);
    if (!evaluator.responseTypes.includes(type.id)) throw new LearningError(503, "EVALUATOR_UNAVAILABLE");
    const key = keyOf(question);
    if (key === undefined) throw new Error("冻结的评分键缺少题目");
    const frozen = value === null ? null : type.parseValue(value, question);
    const result = verdictResult.parse(evaluator.evaluate({
      ...context, practice: { ...context.practice }, questionId, questionVersion, responseType: type.id, value: frozen, key,
    }));
    return { questionId, result };
  });
}

export function judgedOnly(outcomes: readonly { questionId: string; result: VerdictResult }[]) {
  return outcomes.map(({ questionId, result }) => {
    if (result.status !== "judged") throw new Error("选择题评估须给出确定判定");
    return { questionId, correct: result.correct };
  });
}
