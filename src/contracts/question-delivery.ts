import { z } from "zod";
import { choiceConfirmationInput, confirmedQuestionRevision } from "./choice-confirmation.ts";
import { id, versionRef } from "./reading.ts";
import { responseDraftInput, responseDraftValue, responseValue } from "./response.ts";
import type { ResponseDraftInput } from "./response.ts";
import { frozenConfirmationVerdictMode } from "./verdict.ts";
import type { AuthorizeConfirmedReview, AuthorizeConfirmedVerdict } from "./verdict.ts";


export function orderedQuestionValues<T>(values: Record<string, T>) {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1));
}

export const questionDeliveryMode = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("whole") }),
  z.strictObject({ mode: z.literal("perQuestion"), questionSlots: z.record(id, id).transform(orderedQuestionValues) }),
]);
const questionDeliveryKey = z.looseObject({ response: id });
export const questionDeliveryScoringKey = versionRef.extend({
  acceptedByQuestion: z.record(id, questionDeliveryKey).transform(orderedQuestionValues),
});

export const questionDeliveryReviewBasis = versionRef.extend({
  reviewCriteria: z.string().refine(criteria => criteria.trim().length > 0),
});
export const questionDeliveryReviewMode = z.union([z.literal("verdicts"), frozenConfirmationVerdictMode]).optional();
export type AuthorizeQuestionDeliveryReview = AuthorizeConfirmedReview;
export type AuthorizeQuestionDeliveryVerdict = AuthorizeConfirmedVerdict;

export const questionDeliveryDraftInput = responseDraftInput;
export const questionDeliveryDraftValue = responseDraftValue;
export const questionDeliveryInput = z.discriminatedUnion("source", [
  choiceConfirmationInput.extend({ source: z.literal("whole") }),
  choiceConfirmationInput.extend({ source: z.literal("question"), questions: z.tuple([confirmedQuestionRevision]) }),
  choiceConfirmationInput.extend({ source: z.literal("finish") }),
]);

const deliveryWork = z.strictObject({
  kind: z.literal("questionDelivery"),
  slotId: id,
  questions: z.array(confirmedQuestionRevision.extend({ value: responseValue.nullable() })).min(1),
});
export const questionDelivery = z.discriminatedUnion("source", [
  deliveryWork.extend({ source: z.enum(["whole", "question"]) }),
  deliveryWork.extend({ source: z.literal("finish"), requestQuestions: choiceConfirmationInput.shape.questions }),
]);

const questionDeliveryKind = deliveryWork.pick({ kind: true }).loose();
export function readQuestionDelivery(content: unknown) {
  return questionDeliveryKind.safeParse(content).success ? questionDelivery.parse(content) : undefined;
}

export type QuestionDeliveryDraftInput = ResponseDraftInput;
export type QuestionDeliveryInput = z.infer<typeof questionDeliveryInput>;
export type QuestionDelivery = z.infer<typeof questionDelivery>;
export type QuestionDeliveryKey = z.infer<typeof questionDeliveryKey>;

export function questionDeliveryIntent(delivery: QuestionDelivery) {
  if (delivery.source === "finish") return delivery.requestQuestions;
  return delivery.questions.map(({ value, ...revision }) => revision);
}

export function questionDeliveryView({ source, slotId, questions }: QuestionDelivery) {
  return { source, slotId, questions };
}
