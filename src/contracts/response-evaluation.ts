import { z } from "zod";
import { isReservedReadingCapability } from "../builtins/reading-capabilities.ts";
import type { ChoiceEvaluationInput } from "./choice-evaluation.ts";
import { versionRef } from "./reading.ts";
import type { VersionRef } from "./reading.ts";
import type { ResponseValue } from "./response.ts";

export const responseVerdict = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("judged"), correct: z.boolean() }),
  z.strictObject({ status: z.literal("needsReview") }),
]);

export type ResponseVerdict = z.infer<typeof responseVerdict>;
export type ResponseEvaluationInput = Readonly<Omit<ChoiceEvaluationInput, "choice" | "acceptedChoice"> & {
  value: ResponseValue | null;
  acceptedResponse: boolean;
}>;
export type ResponseEvaluator = (input: ResponseEvaluationInput) => ResponseVerdict;

const registration = versionRef.extend({
  evaluate: z.custom<ResponseEvaluator>(value => typeof value === "function"),
});

export const responseEvaluators = z.array(registration).refine(registered =>
  new Set(registered.map(({ id, version }) => JSON.stringify([id, version]))).size === registered.length
  && registered.every(({ id }) => !isReservedReadingCapability(id)),
"须注册唯一且非内置的原值评估器版本");

export type ResponseEvaluatorRegistration = z.infer<typeof registration>;

export function findResponseEvaluator(registered: readonly ResponseEvaluatorRegistration[], { id, version }: VersionRef) {
  return registered.find(evaluator => evaluator.id === id && evaluator.version === version)?.evaluate;
}
