import { z } from "zod";
import { isReservedReadingCapability } from "../builtins/reading-capabilities.ts";
import type { VersionRef } from "./reading.ts";
import { versionRef } from "./reading.ts";

export type ChoiceEvaluationInput = Readonly<{
  activityId: string;
  stepAttemptId: string;
  slotId: string;
  practice: Readonly<VersionRef>;
  questionId: string;
  questionVersion: number;
  choice: string | null;
  acceptedChoice: string;
}>;

export type ChoiceEvaluator = (input: ChoiceEvaluationInput) => boolean;

const choiceEvaluatorRegistration = versionRef.extend({
  evaluate: z.custom<ChoiceEvaluator>(value => typeof value === "function"),
});

export type ChoiceEvaluatorRegistration = z.infer<typeof choiceEvaluatorRegistration>;

export const choiceEvaluators = z.array(choiceEvaluatorRegistration).refine(registered =>
  new Set(registered.map(({ id, version }) => JSON.stringify([id, version]))).size === registered.length
  && registered.every(({ id }) => !isReservedReadingCapability(id)), "宿主评估器必须使用不同的非内置标识和版本");

export function findChoiceEvaluator(registered: readonly ChoiceEvaluatorRegistration[], { id, version }: VersionRef) {
  return registered.find(evaluator => evaluator.id === id && evaluator.version === version)?.evaluate;
}
