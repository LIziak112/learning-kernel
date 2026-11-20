import { z } from "zod";
import { choiceConfirmationInput, confirmedQuestionRevision } from "./choice-confirmation.ts";
import { versionedChoiceDraftInput } from "./choice-draft.ts";

export const responseValue = z.union([z.boolean(), z.string()]);
export const optionIndex = z.int().nonnegative();
export const indexResponseValue = z.array(optionIndex);
export const responseFormat = z.enum(["booleanOrString", "optionIndexArray"]);
export const responseDraftValue = versionedChoiceDraftInput.pick({ questionVersion: true }).extend({ value: responseValue });
export const responseDraftInput = versionedChoiceDraftInput.omit({ choice: true }).extend({ value: responseValue });
export const indexResponseDraftValue = responseDraftValue.extend({ value: indexResponseValue });
export const indexResponseDraftInput = responseDraftInput.extend({ value: indexResponseValue });
export const responseConfirmation = z.strictObject({
  kind: z.literal("responseConfirmation"),
  questions: z.array(confirmedQuestionRevision.extend({ value: responseValue.nullable() })).min(1),
});
export const indexResponseConfirmation = z.strictObject({
  kind: z.literal("indexResponseConfirmation"),
  questions: z.array(confirmedQuestionRevision.extend({ value: indexResponseValue.nullable() })).min(1),
});

const responseConfirmationKind = responseConfirmation.pick({ kind: true }).loose();
export function readResponseConfirmation(content: unknown) {
  return responseConfirmationKind.safeParse(content).success ? responseConfirmation.parse(content) : undefined;
}
const indexResponseConfirmationKind = indexResponseConfirmation.pick({ kind: true }).loose();
export function readIndexResponseConfirmation(content: unknown) {
  return indexResponseConfirmationKind.safeParse(content).success ? indexResponseConfirmation.parse(content) : undefined;
}

export type ResponseValue = z.infer<typeof responseValue>;
export type ResponseDraftInput = z.infer<typeof responseDraftInput>;
export type ResponseConfirmationInput = z.infer<typeof choiceConfirmationInput>;
export type ResponseConfirmation = z.infer<typeof responseConfirmation>;
export type IndexResponseDraftInput = z.infer<typeof indexResponseDraftInput>;
export type IndexResponseConfirmation = z.infer<typeof indexResponseConfirmation>;
export type ResponseFormat = z.infer<typeof responseFormat>;
export type StoredResponseValue = ResponseValue | readonly number[];

export function hasStoredResponse(value: StoredResponseValue | null) {
  return value !== null && (typeof value !== "object" || value.length > 0);
}

export function sameStoredResponse(left: StoredResponseValue | null, right: StoredResponseValue | null) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  return left.length === right.length && left.every((index, offset) => index === right[offset]);
}
