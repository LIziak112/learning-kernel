import { z } from "zod";
import { startInput, startReceipt, versionRef } from "./reading.ts";

export const preparedVersionIntent = z.literal("questionDeliveryMode");

export const preparedVersionInput = startInput.pick({ protocolVersion: true, operationId: true }).extend({
  stepAttemptId: z.uuid(),
  expectedPracticeVersion: versionRef.shape.version,
  practiceVersion: versionRef.shape.version,
  intent: preparedVersionIntent.optional(),
});

export const preparedVersionReceipt = startReceipt.extend({ practiceVersion: versionRef.shape.version });
export type PreparedActivityVersionInput = z.infer<typeof preparedVersionInput>;
export type PreparedActivityVersionReceipt = z.infer<typeof preparedVersionReceipt>;
