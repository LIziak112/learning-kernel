import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { findChoiceEvaluator } from "../contracts/choice-evaluation.ts";
import type { ChoiceEvaluationInput } from "../contracts/choice-evaluation.ts";
import { questionDeliveryScoringKey } from "../contracts/question-delivery.ts";
import type { QuestionDelivery, QuestionDeliveryKey } from "../contracts/question-delivery.ts";
import type { SubmissionReceipt, VersionRef } from "../contracts/reading.ts";
import { findResponseEvaluator } from "../contracts/response-evaluation.ts";
import { indexResponseValue, responseValue } from "../contracts/response.ts";
import type { StoredResponseValue } from "../contracts/response.ts";
import type { ReadingActivity } from "./activity.ts";
import { LearningError } from "./learning-error.ts";
import type { PublicationEvaluators } from "./publication-bindings.ts";
import { recoverEvaluatedResponses } from "./response-evaluation.ts";
import type { EvaluationQuestion } from "./response-evaluation.ts";
import { submissionAssessmentTarget } from "./verdict-state.ts";

export function recoverQuestionDeliveryEvaluation(
  database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, delivery: QuestionDelivery, registered: PublicationEvaluators,
) {
  const target = submissionAssessmentTarget(database, receipt.id);
  return recoverEvaluatedResponses(database, activity, receipt, delivery.questions, (reference, key, context) => {
    const { acceptedByQuestion } = questionDeliveryScoringKey.parse(key);
    return question => {
      const basis = Object.hasOwn(acceptedByQuestion, question.questionId) ? acceptedByQuestion[question.questionId] : undefined;
      if (!basis) throw new Error("冻结的逐题评分键缺少题目");
      const evaluate = evaluateOf(reference, basis, registered);
      return evaluate({ ...context, practice: { ...context.practice }, ...question });
    };
  }, target);
}

type EvaluationInput = Omit<ChoiceEvaluationInput, "choice" | "acceptedChoice"> & EvaluationQuestion<StoredResponseValue>;

const confirmedChoice = z.string().nullable();
const confirmedScalar = responseValue.nullable();
const confirmedIndexes = indexResponseValue.nullable();

function evaluateOf(reference: VersionRef, basis: QuestionDeliveryKey, { choice = [], scalar = [], indexes = [] }: PublicationEvaluators) {
  switch (basis.response) {
    case "choice": {
      const evaluate = requireEvaluator(findChoiceEvaluator(choice, reference));
      return ({ value, ...context }: EvaluationInput) => {
        const correct = evaluate({ ...context, choice: confirmedChoice.parse(value), acceptedChoice: basis.acceptedChoice });
        return { status: "judged" as const, correct };
      };
    }
    case "booleanOrString": {
      const evaluate = requireEvaluator(findResponseEvaluator(scalar, reference));
      return ({ value, ...context }: EvaluationInput) =>
        evaluate({ ...context, value: confirmedScalar.parse(value), acceptedResponse: basis.acceptedResponse });
    }
    case "optionIndexArray": {
      const evaluate = requireEvaluator(findResponseEvaluator(indexes, reference));
      return ({ value, ...context }: EvaluationInput) =>
        evaluate({ ...context, value: confirmedIndexes.parse(value), acceptedIndexes: [...basis.acceptedIndexes] });
    }
  }
}

function requireEvaluator<T>(evaluate: T | undefined) {
  if (!evaluate) throw new LearningError(503, "EVALUATOR_UNAVAILABLE");
  return evaluate;
}
