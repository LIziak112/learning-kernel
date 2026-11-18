import { z } from "zod";
import { draftReceipt, id, range, versionRef } from "./reading.ts";

const roleRange = range.extend({ role: id });
const boundStep = z.strictObject({ stepAttemptId: z.uuid(), slotId: id });

export const readingSaveInput = boundStep.extend({
  protocolVersion: z.literal(1),
  workId: z.uuid().optional(),
  ranges: z.array(roleRange),
});

export const readingSelection = z.strictObject({
  material: versionRef,
  positionId: id,
  ranges: z.array(z.strictObject({ role: id, range, text: z.string().min(1) })),
});

export const readingDraftReceipt = draftReceipt.extend({ selection: readingSelection });

export type ReadingSaveInput = z.infer<typeof readingSaveInput>;
export type ReadingSelection = z.infer<typeof readingSelection>;
