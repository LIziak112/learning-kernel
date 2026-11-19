import { z } from "zod";
import { id, versionRef } from "./reading.ts";

const originalEvidence = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("frozen"), documentId: id, versionId: id,
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("missing") }),
  z.strictObject({ state: z.literal("uncollected") }),
]);

export const confirmationKey = z.strictObject({
  protocolVersion: z.literal(1), stepAttemptId: z.uuid(), operationId: id,
});

const questionRevision = z.strictObject({
  questionId: id, questionVersion: versionRef.shape.version, revision: z.int().nonnegative(), original: originalEvidence,
});

export const choiceConfirmationInput = confirmationKey.extend({
  slotId: id, questions: z.array(questionRevision).min(1),
});

const confirmedQuestion = questionRevision.extend({ choice: id.nullable() });
export const choiceConfirmation = z.strictObject({
  kind: z.literal("choiceConfirmation"), questions: z.array(confirmedQuestion).min(1),
});
const confirmationKind = choiceConfirmation.pick({ kind: true }).loose();

export function readChoiceConfirmation(content: unknown) {
  return confirmationKind.safeParse(content).success ? choiceConfirmation.parse(content) : undefined;
}

export type ChoiceConfirmationInput = z.infer<typeof choiceConfirmationInput>;
export type ConfirmationKey = z.infer<typeof confirmationKey>;
export type ChoiceConfirmation = z.infer<typeof choiceConfirmation>;

export type ConfirmationScope = {
  studentId: string;
  activityId: string;
  stepAttemptId: string;
  operationId: string;
};
export type VerifyOriginal = (scope: ConfirmationScope & {
  slotId: string;
  questionId: string;
  questionVersion: number;
  original: Readonly<z.infer<typeof originalEvidence>>;
}) => boolean;
export type AuthorizeConfirmationRecovery = (scope: ConfirmationScope) => boolean;
