import { z } from "zod";
import { defaultEvaluators, defaultResponseTypes, defaultTools } from "../../src/extensions/index.ts";
import { createRegistry } from "../../src/kernel/registry.ts";
import type {
  AuthorizeReview, EvaluationInput, EvaluatorRegistration, QuestionAnswerRule, ReviewAccess, ReviewedDelivery, ReviewScope, VerdictResult,
} from "../../src/server.ts";

type Reference = { id: string; version: number };
type Context = Omit<EvaluationInput, "responseType" | "value" | "key">;
type Judge<Fields> = (input: Readonly<Context & Fields>) => VerdictResult;

export const defaultRegistry = createRegistry({
  tools: defaultTools, responseTypes: defaultResponseTypes, evaluators: defaultEvaluators, answerRules: [],
});

function adapter<Value, Key, Fields>(
  responseType: string, value: z.ZodType<Value>, key: z.ZodType<Key>, fields: (value: Value | null, key: Key) => Fields,
) {
  return (reference: Reference, judge: Judge<Fields>): EvaluatorRegistration => ({
    ...reference, responseTypes: [responseType],
    evaluate: ({ responseType: _type, value: raw, key: rawKey, ...context }) =>
      judge({ ...context, ...fields(raw === null ? null : value.parse(raw), key.parse(rawKey)) }),
  });
}

const choiceKey = z.strictObject({ acceptedChoice: z.string() });
export function choiceEvaluator(reference: Reference, judge: (input: Readonly<Context & { choice: string | null; acceptedChoice: string }>) => boolean) {
  return adapter("choice", z.string(), choiceKey, (choice, { acceptedChoice }) => ({ choice, acceptedChoice }))(reference,
    input => ({ status: "judged", correct: judge(input) }));
}

export const booleanEvaluator = adapter("booleanOrString", z.union([z.boolean(), z.string()]),
  z.strictObject({ acceptedResponse: z.boolean() }), (value, { acceptedResponse }) => ({ value, acceptedResponse }));

export const indexEvaluator = adapter("optionIndexArray", z.array(z.int()),
  z.strictObject({ acceptedIndexes: z.array(z.int()) }), (value, { acceptedIndexes }) => ({ value, acceptedIndexes }));

export const orderedTextEvaluator = adapter("orderedTextBlanks", z.array(z.string()),
  z.strictObject({ acceptedBlanks: z.array(z.array(z.string())) }), (value, { acceptedBlanks }) => ({ value, acceptedBlanks }));

const titledText = z.strictObject({ body: z.string(), title: z.string().optional() })
  .transform(({ body, title }): { body: string; title?: string } => title === undefined ? { body } : { body, title });
export const titledTextEvaluator = adapter("textWithOptionalTitle", titledText, z.strictObject({}), value => ({ value }));

export function combinedEvaluator(...registrations: readonly EvaluatorRegistration[]): EvaluatorRegistration {
  const [first] = registrations;
  if (!first || registrations.some(({ id, version }) => id !== first.id || version !== first.version)) {
    throw new Error("合并的评估器须同名同版本");
  }
  return {
    id: first.id, version: first.version, responseTypes: registrations.flatMap(({ responseTypes }) => responseTypes),
    evaluate(input) {
      const handler = registrations.find(({ responseTypes }) => responseTypes.includes(input.responseType));
      if (!handler) throw new Error(`评估器未覆盖 ${input.responseType}`);
      return handler.evaluate(input);
    },
  };
}

export const scalarValue = z.union([z.boolean(), z.string()]);
export const titledValue = titledText;
export function answerRule<Value>(
  reference: Reference, responseType: string, value: z.ZodType<Value>, isAnswered: (value: Value) => boolean,
): QuestionAnswerRule {
  return { ...reference, responseType, isAnswered: raw => isAnswered(value.parse(raw)) };
}

export type ChoiceInput = Readonly<Context & { choice: string | null; acceptedChoice: string }>;
export type ScalarInput = Parameters<Parameters<typeof booleanEvaluator>[1]>[0];
export type IndexInput = Parameters<Parameters<typeof indexEvaluator>[1]>[0];
export type OrderedTextInput = Parameters<Parameters<typeof orderedTextEvaluator>[1]>[0];
export type TitledTextInput = Parameters<Parameters<typeof titledTextEvaluator>[1]>[0];

type RevisionAccess = Extract<ReviewAccess, { purpose: "reviseVerdict" }>;
type DeliveryHooks = { read?: (scope: ReviewScope) => boolean; write?: (access: RevisionAccess) => boolean };
export function reviewAccess(byDelivery: Partial<Record<ReviewedDelivery, DeliveryHooks>>): AuthorizeReview {
  return access => {
    const hooks = byDelivery[access.delivery];
    return access.purpose === "readReview" ? hooks?.read?.(access) === true : hooks?.write?.(access) === true;
  };
}
