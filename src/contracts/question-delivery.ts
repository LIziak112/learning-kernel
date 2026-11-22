import { z } from "zod";
import { choiceConfirmationInput, confirmedQuestionRevision } from "./choice-confirmation.ts";
import { id, versionRef } from "./reading.ts";
import { indexResponseValue, optionIndex, orderedTextResponseValue, responseDraftInput, responseValue, titledTextResponseValue } from "./response.ts";
import { frozenConfirmationVerdictMode } from "./verdict.ts";
import type { AuthorizeConfirmedReview, AuthorizeConfirmedVerdict } from "./verdict.ts";

export const orderedTextFormat = z.literal("orderedTextBlanks");
export const titledTextFormat = z.literal("textWithOptionalTitle");
export const choiceAndResponseFormat = z.enum(["choice", "booleanOrString", "optionIndexArray"]);
const deliveryValue = z.union([responseValue, indexResponseValue, orderedTextResponseValue, titledTextResponseValue]);

export function orderedQuestionValues<T>(values: Record<string, T>) {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1));
}

export const questionDeliveryMode = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("whole") }),
  z.strictObject({ mode: z.literal("perQuestion"), questionSlots: z.record(id, id).transform(orderedQuestionValues) }),
]);
const questionDeliveryKey = z.discriminatedUnion("response", [
  z.strictObject({ response: z.literal("choice"), acceptedChoice: id }),
  z.strictObject({ response: z.literal("booleanOrString"), acceptedResponse: z.boolean() }),
  z.strictObject({ response: z.literal("optionIndexArray"), acceptedIndexes: z.array(optionIndex).min(1) }),
  z.strictObject({ response: orderedTextFormat, acceptedBlanks: z.array(z.array(z.string().min(1))).min(1) }),
  z.strictObject({ response: titledTextFormat }),
]);
export const questionDeliveryScoringKey = versionRef.extend({
  acceptedByQuestion: z.record(id, questionDeliveryKey).transform(orderedQuestionValues),
});

export const questionDeliveryReviewBasis = versionRef.extend({
  reviewCriteria: z.string().refine(criteria => criteria.trim().length > 0),
});
export const questionDeliveryReviewMode = z.union([z.literal("verdicts"), frozenConfirmationVerdictMode]).optional();
export type AuthorizeQuestionDeliveryReview = AuthorizeConfirmedReview;
export type AuthorizeQuestionDeliveryVerdict = AuthorizeConfirmedVerdict;

export const questionDeliveryDraftInput = responseDraftInput.extend({ value: deliveryValue });
export const questionDeliveryDraftValue = questionDeliveryDraftInput.pick({ questionVersion: true, value: true });
export const questionDeliveryInput = z.discriminatedUnion("source", [
  choiceConfirmationInput.extend({ source: z.literal("whole") }),
  choiceConfirmationInput.extend({ source: z.literal("question"), questions: z.tuple([confirmedQuestionRevision]) }),
  choiceConfirmationInput.extend({ source: z.literal("finish") }),
]);

const deliveryWork = z.strictObject({
  kind: z.literal("questionDelivery"),
  slotId: id,
  questions: z.array(confirmedQuestionRevision.extend({ value: deliveryValue.nullable() })).min(1),
});
export const questionDelivery = z.discriminatedUnion("source", [
  deliveryWork.extend({ source: z.enum(["whole", "question"]) }),
  deliveryWork.extend({ source: z.literal("finish"), requestQuestions: choiceConfirmationInput.shape.questions }),
]);

const questionDeliveryKind = deliveryWork.pick({ kind: true }).loose();
export function readQuestionDelivery(content: unknown) {
  return questionDeliveryKind.safeParse(content).success ? questionDelivery.parse(content) : undefined;
}

export type QuestionDeliveryDraftInput = z.infer<typeof questionDeliveryDraftInput>;
export type QuestionDeliveryInput = z.infer<typeof questionDeliveryInput>;
export type QuestionDelivery = z.infer<typeof questionDelivery>;
export type QuestionDeliveryKey = z.infer<typeof questionDeliveryKey>;
export type QuestionDeliveryFormat = QuestionDeliveryKey["response"];

export function questionDeliveryIntent(delivery: QuestionDelivery) {
  if (delivery.source === "finish") return delivery.requestQuestions;
  return delivery.questions.map(({ value, ...revision }) => revision);
}

export function questionDeliveryView({ source, slotId, questions }: QuestionDelivery) {
  return { source, slotId, questions };
}
