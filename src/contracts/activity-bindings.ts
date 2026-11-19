import { z } from "zod";
import { id, startInput, startReceipt } from "./reading.ts";

export const activityOpeningKey = z.strictObject({ studentId: id, operationId: startInput.shape.operationId });
export const activityBinding = activityOpeningKey.extend({ activityId: startReceipt.shape.activityId });

export const activityBindingClaims = z.strictObject({
  protocolVersion: startInput.shape.protocolVersion,
  bindings: z.array(activityBinding),
  openingIntents: z.array(activityOpeningKey),
});

export type ActivityBindingClaims = z.infer<typeof activityBindingClaims>;
export type ActivityOpeningKey = z.infer<typeof activityOpeningKey>;
