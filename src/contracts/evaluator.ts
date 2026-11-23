import { z } from "zod";
import type { VersionRef } from "./reading.ts";

export const verdictResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("judged"), correct: z.boolean() }),
  z.strictObject({ status: z.literal("needsReview") }),
]);

export type VerdictResult = z.infer<typeof verdictResult>;

export type EvaluationContext = Readonly<{
  activityId: string;
  stepAttemptId: string;
  slotId: string;
  practice: Readonly<VersionRef>;
}>;

export type EvaluationInput = EvaluationContext & Readonly<{
  questionId: string;
  questionVersion: number;
  responseType: string;
  value: unknown;
  key: unknown;
}>;

export type Evaluator = (input: EvaluationInput) => VerdictResult;

export type EvaluatorRegistration = Readonly<VersionRef> & {
  readonly responseTypes: readonly string[];
  readonly evaluate: Evaluator;
};

export type QuestionAnswerRule = Readonly<VersionRef> & {
  readonly responseType: string;
  readonly isAnswered: (value: unknown) => boolean;
};
