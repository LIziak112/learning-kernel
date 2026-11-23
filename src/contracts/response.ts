import { z } from "zod";
import { choiceConfirmationInput, confirmedQuestionRevision } from "./choice-confirmation.ts";
import { versionedChoiceDraftInput } from "./choice-draft.ts";

export const responseValue = z.json();
export const responseDraftValue = versionedChoiceDraftInput.pick({ questionVersion: true }).extend({ value: responseValue });
export const responseDraftInput = versionedChoiceDraftInput.omit({ choice: true }).extend({ value: z.unknown() });
export const responseConfirmation = z.strictObject({
  kind: z.literal("responseConfirmation"),
  questions: z.array(confirmedQuestionRevision.extend({ value: responseValue.nullable() })).min(1),
});

const storedConfirmation = responseConfirmation.extend({ kind: z.enum(["responseConfirmation", "indexResponseConfirmation"]) });
const storedConfirmationKind = storedConfirmation.pick({ kind: true }).loose();

export function readResponseConfirmation(content: unknown): ResponseConfirmation | undefined {
  if (!storedConfirmationKind.safeParse(content).success) return undefined;
  const { questions } = storedConfirmation.parse(content);
  return { kind: "responseConfirmation", questions };
}

export type ResponseValue = z.infer<typeof responseValue>;
export type ResponseDraftRequest = z.infer<typeof responseDraftInput>;
export type ResponseDraftInput = Omit<ResponseDraftRequest, "value"> & { value: ResponseValue };
export type ResponseConfirmationInput = z.infer<typeof choiceConfirmationInput>;
export type ResponseConfirmation = z.infer<typeof responseConfirmation>;
