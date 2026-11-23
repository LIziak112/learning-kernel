import { z } from "zod";

export const gradingPolicy = z.strictObject({
  version: z.literal(1),
  withReference: z.enum(["selfReview", "teacherReview"]),
});

export type GradingPolicy = z.infer<typeof gradingPolicy>;
export type GradingPolicyField = keyof GradingPolicy;

export const defaultGradingPolicy: GradingPolicy = Object.freeze({ version: 1, withReference: "selfReview" });

export type QuestionGradingFacts = Readonly<{ automatic: boolean; reference: boolean }>;
export type QuestionGrading = "automatic" | "selfReview" | "teacherReview";
