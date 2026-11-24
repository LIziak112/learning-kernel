import { z } from "zod";
import { id } from "./reading.ts";

export const selfAssessmentScoring = z.enum(["separate", "countAsCorrect"]);
export const selfAssessmentPolicy = z.strictObject({ scoring: selfAssessmentScoring });
export const selfAssessmentVerdict = z.enum(["correct", "wrong"]);
export const selfAssessmentRubric = z.record(id, z.union([z.string().max(5000), z.number().finite()]))
  .refine(rubric => Object.keys(rubric).length <= 100, "自评细则项过多");

export const selfAssessmentInput = z.strictObject({
  protocolVersion: z.literal(1),
  operationId: id,
  questionId: id,
  expectedRevision: z.int().nonnegative(),
  verdict: selfAssessmentVerdict.nullable(),
  rubric: selfAssessmentRubric.optional(),
});

export const selfAssessmentReceipt = z.strictObject({
  id: z.uuid(),
  submissionId: z.uuid(),
  questionId: id,
  revision: z.int().positive(),
  verdict: selfAssessmentVerdict.nullable(),
  rubric: selfAssessmentRubric.optional(),
});

export type SelfAssessmentScoring = z.infer<typeof selfAssessmentScoring>;
export type SelfAssessmentVerdict = z.infer<typeof selfAssessmentVerdict>;
export type SelfAssessmentInput = z.infer<typeof selfAssessmentInput>;
export type SelfAssessmentReceipt = z.infer<typeof selfAssessmentReceipt>;
