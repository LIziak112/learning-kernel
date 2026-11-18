import { z } from "zod";

const id = z.string().min(1).max(128);
const version = z.int().positive();
const protocolVersion = z.literal(1);

const versionRef = z.strictObject({ id, version });
const paragraph = z.strictObject({ id, text: z.string().min(1) });

export const materialSchema = versionRef.extend({
  source: z.string().min(1),
  title: z.string().min(1),
  paragraphs: z.array(paragraph).min(1).refine(items => new Set(items.map(item => item.id)).size === items.length),
});

export const stepSchema = z.strictObject({
  id,
  instructions: z.string().min(1),
  tool: z.strictObject({ id: z.literal("text-selection"), version: z.literal(1) }),
  positionId: id,
  slotId: id,
  targetId: id,
});

export const practiceSchema = versionRef.extend({
  title: z.string().min(1),
  material: versionRef,
  steps: z.tuple([stepSchema]),
});

export const publicationSchema = z.strictObject({
  material: materialSchema,
  practice: practiceSchema,
});

export const startInput = z.strictObject({ protocolVersion, operationId: id, practiceId: id });
export const startReceipt = z.strictObject({
  activityId: z.uuid(),
  stepAttemptId: z.uuid(),
  startedAt: z.iso.datetime(),
});

const range = z.strictObject({
  paragraphId: id,
  start: z.int().nonnegative(),
  end: z.int().positive(),
});

export const selectionSchema = z.strictObject({
  material: versionRef,
  positionId: id,
  range,
  text: z.string().min(1),
});

export const saveInput = z.strictObject({ protocolVersion, workId: z.uuid().optional(), range });
export const draftReceipt = z.strictObject({
  draft: z.strictObject({ id: z.uuid(), version }),
  selection: selectionSchema,
});

export const submitInput = z.strictObject({
  protocolVersion,
  operationId: id,
  stepAttemptId: z.uuid(),
  slotId: id,
  draft: draftReceipt.shape.draft,
});
export const submissionReceipt = z.strictObject({
  id: z.uuid(),
  stepAttemptId: z.uuid(),
  slotId: id,
  confirmedAt: z.iso.datetime(),
});

export const submissionDetail = z.strictObject({ receipt: submissionReceipt, selection: selectionSchema });
export const activityDetail = startReceipt.extend({
  title: z.string(),
  material: materialSchema,
  step: stepSchema,
  status: z.enum(["active", "completed"]),
  submission: submissionDetail.nullable(),
});

export type Material = z.infer<typeof materialSchema>;
export type Step = z.infer<typeof stepSchema>;
export type StartInput = z.infer<typeof startInput>;
export type SaveInput = z.infer<typeof saveInput>;
export type SubmitInput = z.infer<typeof submitInput>;
export type SubmissionReceipt = z.infer<typeof submissionReceipt>;
export type SubmissionDetail = z.infer<typeof submissionDetail>;
export type ActivityDetail = z.infer<typeof activityDetail>;
