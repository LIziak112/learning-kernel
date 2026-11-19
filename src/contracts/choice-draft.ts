import { z } from "zod";
import { id, versionRef } from "./reading.ts";

export const choiceDraftValue = z.strictObject({ questionVersion: versionRef.shape.version, choice: id });

export const choiceDraftInput = choiceDraftValue.extend({
  protocolVersion: z.literal(1),
  operationId: id,
  stepAttemptId: z.uuid(),
  slotId: id,
  questionId: id,
  baseRevision: z.int().nonnegative(),
});

export type ChoiceDraftInput = z.infer<typeof choiceDraftInput>;
