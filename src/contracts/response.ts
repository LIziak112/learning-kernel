import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { choiceConfirmationInput, confirmedQuestionRevision } from "./choice-confirmation.ts";
import { versionedChoiceDraftInput } from "./choice-draft.ts";

export const responseValue = z.union([z.boolean(), z.string()]);
export const optionIndex = z.int().nonnegative();
export const indexResponseValue = z.array(optionIndex);
export const orderedTextResponseValue = z.array(z.string());
export const titledTextResponseValue = z.strictObject({ body: z.string(), title: z.string().optional() })
  .transform(({ body, title }): { body: string; title?: string } => title === undefined ? { body } : { body, title });
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
export type TitledTextResponseValue = z.infer<typeof titledTextResponseValue>;
export type StoredResponseValue = ResponseValue | readonly number[] | readonly string[] | TitledTextResponseValue;

export function hasStoredResponse(value: StoredResponseValue | null) {
  if (value === null) return false;
  if (typeof value !== "object") return true;
  if ("body" in value) return value.body.trim() !== "";
  return value.some(item => typeof item === "number" || item.trim() !== "");
}

export function sameStoredResponse(left: StoredResponseValue | null, right: StoredResponseValue | null) {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  if ("body" in left || "body" in right) return isDeepStrictEqual(left, right);
  return left.length === right.length && left.every((item, offset) => item === right[offset]);
}
