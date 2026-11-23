import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { wholePaperScoringKey } from "../contracts/reading-publication.ts";
import type { ReadingActivity } from "./activity.ts";
import { revisedChoiceKey } from "./choice-snapshot-store.ts";
import { loadEvaluationKey, recordEvaluation } from "./evaluation.ts";
import { evaluateFrozenAnswers, evaluationContext, judgedOnly } from "./question-evaluation.ts";
import { frozenResponseType, wholePaperQuestionKey } from "./question-types.ts";
import type { Registry } from "./registry.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

const verdict = z.boolean();

export function recoverChoiceEvaluation(
  database: DatabaseSync, registry: Registry, activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ChoiceConfirmation,
) {
  const assessment = activity.practice.grading.assessment;
  if (!assessment) return undefined;
  const target = assessmentTarget(database, activity.activityId);
  if (target?.submissionId !== receipt.id) throw new Error("已确认的评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status === "pending") {
    const context = evaluationContext(activity, receipt);
    const key = wholePaperScoringKey.parse(loadEvaluationKey(database, receipt.id));
    const answers = confirmation.questions.map(({ questionId, questionVersion, choice }) => ({ questionId, questionVersion, value: choice }));
    const versions = new Map(answers.map(({ questionId, questionVersion }) => [questionId, questionVersion]));
    const outcomes = evaluateFrozenAnswers(registry, activity.practice, evaluator, context, answers, question => {
      const revised = revisedChoiceKey(database, { ...context, questionId: question.id }, versions.get(question.id) ?? 0);
      if (revised !== undefined) return { acceptedChoice: revised };
      return wholePaperQuestionKey(key, frozenResponseType(registry, activity.practice, question), question);
    });
    recordEvaluation(database, target, judgedOnly(outcomes));
  }
  const automatic = new Map(readAutomaticVerdicts(database, target).map(({ questionId, correct }) => [questionId, correct]));
  const questions = confirmation.questions.map(({ questionId, questionVersion }) => ({
    questionId, questionVersion, correct: verdict.parse(automatic.get(questionId)),
  }));
  return { evaluator, questionCount: questions.length, correctCount: questions.filter(question => question.correct).length, questions };
}
