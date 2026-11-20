import { z } from "zod";
import { choiceConfirmationInput, confirmedQuestionRevision } from "./choice-confirmation.ts";
import { versionedChoiceDraftInput } from "./choice-draft.ts";

export const responseValue = z.union([z.boolean(), z.string()]);
export const responseDraftValue = versionedChoiceDraftInput.pick({ questionVersion: true }).extend({ value: responseValue });
export const responseDraftInput = versionedChoiceDraftInput.omit({ choice: true }).extend({ value: responseValue });
export const responseConfirmation = z.strictObject({
  kind: z.literal("responseConfirmation"),
  questions: z.array(confirmedQuestionRevision.extend({ value: responseValue.nullable() })).min(1),
});

const responseConfirmationKind = responseConfirmation.pick({ kind: true }).loose();
export function readResponseConfirmation(content: unknown) {
  return responseConfirmationKind.safeParse(content).success ? responseConfirmation.parse(content) : undefined;
}

export type ResponseValue = z.infer<typeof responseValue>;
export type ResponseDraftInput = z.infer<typeof responseDraftInput>;
export type ResponseConfirmationInput = z.infer<typeof choiceConfirmationInput>;
export type ResponseConfirmation = z.infer<typeof responseConfirmation>;
