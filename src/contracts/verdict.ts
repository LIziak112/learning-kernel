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

export type ReviewedDelivery = "questionDelivery" | FrozenConfirmationVerdictMode;
export type ReviewScope = Readonly<ConfirmationScope & {
  reviewerId: string;
  submissionId: string;
  slotId: string;
  delivery: ReviewedDelivery;
}>;
export type ReviewAccess = ReviewScope & (
  | Readonly<{ purpose: "readReview" }>
  | Readonly<{ purpose: "reviseVerdict"; targetId: string; questionId: string; questionVersion: number; action: VerdictCommand["action"] }>
);
export type AuthorizeReview = (access: ReviewAccess) => boolean;
