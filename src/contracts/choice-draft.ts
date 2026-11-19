import { z } from "zod";
import { id, versionRef } from "./reading.ts";

export const choiceDraftValue = z.strictObject({ questionVersion: versionRef.shape.version, choice: id });

const unversionedChoiceDraftInput = choiceDraftValue.extend({
  protocolVersion: z.literal(1),
  stepAttemptId: z.uuid(),
  slotId: id,
  questionId: id,
});

const versionedChoiceDraftInput = unversionedChoiceDraftInput.extend({
  operationId: id,
  baseRevision: z.int().nonnegative(),
});

export const choiceDraftInput = z.union([versionedChoiceDraftInput, unversionedChoiceDraftInput]);
export type ChoiceDraftInput = z.infer<typeof versionedChoiceDraftInput>;
export type UnversionedChoiceDraftInput = z.infer<typeof unversionedChoiceDraftInput> & { operationId?: never; baseRevision?: never };
