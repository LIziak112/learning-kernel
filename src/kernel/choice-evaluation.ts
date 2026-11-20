import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import { findChoiceEvaluator } from "../contracts/choice-evaluation.ts";
import type { ChoiceEvaluationInput, ChoiceEvaluator, ChoiceEvaluatorRegistration } from "../contracts/choice-evaluation.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { scoringKeySchema } from "../contracts/reading-publication.ts";
import type { ReadingActivity } from "./activity.ts";
import { revisedChoiceKey } from "./choice-snapshot-store.ts";
import { loadEvaluationKey, recordEvaluation } from "./evaluation.ts";
import { LearningError } from "./learning-error.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

const verdict = z.boolean();

export function recoverChoiceEvaluation(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ChoiceConfirmation,
  registered: readonly ChoiceEvaluatorRegistration[],
) {
  const assessment = activity.practice.grading.assessment;
  if (!assessment) return undefined;
  const target = assessmentTarget(database, activity.activityId);
  if (target?.submissionId !== receipt.id) throw new Error("已确认的评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status === "pending") {
    const evaluate = findChoiceEvaluator(registered, evaluator);
    if (!evaluate) throw new LearningError(503, "EVALUATOR_UNAVAILABLE");
    const context = {
      activityId: activity.activityId, stepAttemptId: receipt.stepAttemptId, slotId: receipt.slotId,
      practice: { id: activity.practice.id, version: activity.practice.version },
    };
    const key = scoringKeySchema.parse(loadEvaluationKey(database, receipt.id));
    recordEvaluation(database, target, evaluateConfirmedChoices(database, evaluate, context, key, confirmation));
  }
  const automatic = new Map(readAutomaticVerdicts(database, target).map(({ questionId, correct }) => [questionId, correct]));
  const questions = confirmation.questions.map(({ questionId, questionVersion }) => ({
    questionId, questionVersion, correct: verdict.parse(automatic.get(questionId)),
  }));
  return { evaluator, questionCount: questions.length, correctCount: questions.filter(question => question.correct).length, questions };
}

function evaluateConfirmedChoices(
  database: DatabaseSync, evaluate: ChoiceEvaluator, context: Pick<ChoiceEvaluationInput, "activityId" | "stepAttemptId" | "slotId" | "practice">,
  key: z.infer<typeof scoringKeySchema>, confirmation: ChoiceConfirmation,
) {
  return confirmation.questions.map(({ questionId, questionVersion, choice }) => {
    const acceptedChoice = revisedChoiceKey(database, { ...context, questionId }, questionVersion) ?? key.acceptedChoices[questionId];
    if (acceptedChoice === undefined) throw new Error("冻结的评分键缺少题目");
    const correct = verdict.parse(evaluate({ ...context, practice: { ...context.practice }, questionId, questionVersion, choice, acceptedChoice }));
    return { questionId, correct };
  });
}
