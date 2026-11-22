import { z } from "zod";
import type { ConfirmationScope } from "./choice-confirmation.ts";
import { id } from "./reading.ts";

export const frozenConfirmationVerdictMode = z.enum(["choiceConfirmation", "responseConfirmation"]);
export type FrozenConfirmationVerdictMode = z.infer<typeof frozenConfirmationVerdictMode>;
export const verdictLocation = z.strictObject({ submissionId: z.uuid(), targetId: id, questionId: id });
const review = verdictLocation.extend({
  protocolVersion: z.literal(1),
  operationId: id,
  expectedRevision: z.int().nonnegative(),
  reason: z.string().trim().min(1).max(5000),
});

export const verdictCommand = z.discriminatedUnion("action", [
  review.extend({ action: z.literal("override"), correct: z.boolean() }),
  review.extend({ action: z.literal("withdraw"), withdrawId: z.uuid() }),
]);

export const verdictReceipt = verdictLocation.extend({ id: z.uuid(), revision: z.int().positive() });
export type VerdictCommand = z.infer<typeof verdictCommand>;
export type VerdictReceipt = z.infer<typeof verdictReceipt>;
export type VerdictLocation = z.infer<typeof verdictLocation>;

type ConfirmedReviewScope = ConfirmationScope & {
  reviewerId: string;
  submissionId: string;
  slotId: string;
};
export type AuthorizeConfirmedReview = (scope: Readonly<ConfirmedReviewScope>) => boolean;
export type AuthorizeConfirmedVerdict = (scope: Readonly<ConfirmedReviewScope & {
  targetId: string;
  questionId: string;
  questionVersion: number;
  action: VerdictCommand["action"];
}>) => boolean;
