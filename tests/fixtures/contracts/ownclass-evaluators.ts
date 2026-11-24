import { booleanEvaluator } from "../evaluators.ts";

export function ownClassJudgeEvaluator(reference: Readonly<{ id: string; version: number }>) {
  return booleanEvaluator({ ...reference }, ({ value, acceptedResponse }) =>
    ({ status: "judged", correct: value !== null && value === acceptedResponse }));
}
