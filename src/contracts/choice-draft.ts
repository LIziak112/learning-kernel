import { z } from "zod";
import { id, versionRef } from "./reading.ts";

export const choiceDraftValue = z.strictObject({ questionVersion: versionRef.shape.version, choice: id });

const unversionedChoiceDraftInput = choiceDraftValue.extend({
  protocolVersion: z.literal(1),
  stepAttemptId: z.uuid(),
  slotId: id,
  questionId: id,
});

export const choiceDraftScope = unversionedChoiceDraftInput.omit({ choice: true });

export const versionedChoiceDraftInput = unversionedChoiceDraftInput.extend({
  operationId: id,
  baseRevision: z.int().nonnegative(),
});

export const choiceDraftInput = z.union([versionedChoiceDraftInput, unversionedChoiceDraftInput]);
export const currentChoiceDraftMode = z.enum(["save", "replayLatestOnly"]);
export type CurrentChoiceDraftMode = z.infer<typeof currentChoiceDraftMode>;
export type ChoiceDraftScope = z.infer<typeof choiceDraftScope>;
export type ChoiceDraftInput = z.infer<typeof versionedChoiceDraftInput>;
export type UnversionedChoiceDraftInput = z.infer<typeof unversionedChoiceDraftInput> & { operationId?: never; baseRevision?: never };
