import { z } from "zod";
import { id } from "./reading.ts";

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
export type VerdictLocation = z.infer<typeof verdictLocation>;
