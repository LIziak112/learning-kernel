import { z } from "zod";
import { id, startInput, startReceipt } from "./reading.ts";

export const activityOpeningKey = z.strictObject({ studentId: id, operationId: startInput.shape.operationId });
export const activityBinding = activityOpeningKey.extend({ activityId: startReceipt.shape.activityId });

export const teacherAmendmentBinding = z.strictObject({
  kind: z.enum(["answer", "snapshot"]),
  activityId: startReceipt.shape.activityId,
  studentId: id,
  stepAttemptId: startReceipt.shape.stepAttemptId,
  slotId: id,
  questionId: id,
  reviewerId: id,
  operationId: id,
  revision: z.int().positive(),
});

export const teacherAmendmentBindingClaims = z.strictObject({
  completed: z.array(teacherAmendmentBinding),
  pending: z.array(teacherAmendmentBinding),
});

export const activityBindingClaims = z.strictObject({
  protocolVersion: startInput.shape.protocolVersion,
  bindings: z.array(activityBinding),
  openingIntents: z.array(activityOpeningKey),
  teacherAmendments: teacherAmendmentBindingClaims.optional(),
});

export type ActivityBindingClaims = z.infer<typeof activityBindingClaims>;
export type ActivityOpeningKey = z.infer<typeof activityOpeningKey>;
export type TeacherAmendmentBinding = z.infer<typeof teacherAmendmentBinding>;
export type TeacherAmendmentBindingClaims = z.infer<typeof teacherAmendmentBindingClaims>;
