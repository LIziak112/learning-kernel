import { z } from "zod";
import type { QuestionDeliveryFormat } from "./question-delivery.ts";
import { versionRef } from "./reading.ts";
import type { VersionRef } from "./reading.ts";
import { indexResponseValue, orderedTextResponseValue, responseValue, titledTextResponseValue } from "./response.ts";
import type { StoredResponseValue } from "./response.ts";

const answeredSchema = z.boolean();

function registration<Format extends QuestionDeliveryFormat, Value extends StoredResponseValue>(
  response: Format, value: z.ZodType<Value>,
) {
  return versionRef.extend({
    response: z.literal(response),
    isAnswered: z.custom<(input: Readonly<Value>) => boolean>(candidate => typeof candidate === "function"),
  }).transform(({ isAnswered, ...binding }) => ({
    ...binding,
    isAnswered: (raw: StoredResponseValue) => answeredSchema.parse(isAnswered(value.parse(raw))),
  }));
}

export const questionAnswerRules = z.array(z.union([
  registration("choice", z.string()),
  registration("booleanOrString", responseValue),
  registration("optionIndexArray", indexResponseValue),
  registration("orderedTextBlanks", orderedTextResponseValue),
  registration("textWithOptionalTitle", titledTextResponseValue),
])).refine(rules => new Set(rules.map(({ id, version }) => JSON.stringify([id, version]))).size === rules.length,
  "须注册唯一的题目已答规则版本");

export type QuestionAnswerRuleRegistration = z.input<typeof questionAnswerRules>[number];
export type BoundQuestionAnswerRules = readonly z.output<typeof questionAnswerRules>[number][];

export function findQuestionAnswerRule(
  rules: BoundQuestionAnswerRules, reference: VersionRef, response: QuestionDeliveryFormat | undefined,
) {
  return rules.find(rule => rule.id === reference.id && rule.version === reference.version && rule.response === response);
}
