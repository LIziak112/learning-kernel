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
export type IndexResponseEvaluationInput = Readonly<Omit<ResponseEvaluationInput, "value" | "acceptedResponse"> & {
  value: readonly number[] | null;
  acceptedIndexes: readonly number[];
}>;
export type IndexResponseEvaluator = (input: IndexResponseEvaluationInput) => ResponseVerdict;
export type OrderedTextEvaluationInput = Readonly<Omit<ResponseEvaluationInput, "value" | "acceptedResponse"> & {
  value: readonly string[] | null;
  acceptedBlanks: readonly (readonly string[])[];
}>;
export type OrderedTextEvaluator = (input: OrderedTextEvaluationInput) => ResponseVerdict;

const registration = versionRef.extend({
  evaluate: z.custom<ResponseEvaluator>(value => typeof value === "function"),
});

function validRegistrations(registered: readonly VersionRef[]) {
  const identities = new Set(registered.map(({ id, version }) => JSON.stringify([id, version])));
  return identities.size === registered.length && registered.every(({ id }) => !isReservedReadingCapability(id));
}

const registrationIssue = "须注册唯一且非内置的原值评估器版本";
export const responseEvaluators = z.array(registration).refine(validRegistrations, registrationIssue);
export const indexResponseEvaluators = z.array(registration.extend({
  evaluate: z.custom<IndexResponseEvaluator>(value => typeof value === "function"),
})).refine(validRegistrations, registrationIssue);
export const orderedTextEvaluators = z.array(registration.extend({
  evaluate: z.custom<OrderedTextEvaluator>(value => typeof value === "function"),
})).refine(validRegistrations, registrationIssue);

export type ResponseEvaluatorRegistration = z.infer<typeof registration>;
export type IndexResponseEvaluatorRegistration = z.infer<typeof indexResponseEvaluators>[number];
export type OrderedTextEvaluatorRegistration = z.infer<typeof orderedTextEvaluators>[number];

export function findResponseEvaluator<T extends VersionRef & { evaluate: unknown }>(registered: readonly T[], { id, version }: VersionRef): T["evaluate"] | undefined {
  return registered.find(evaluator => evaluator.id === id && evaluator.version === version)?.evaluate;
}
