import { z } from "zod";
import type { EvaluatorRegistration } from "../contracts/evaluator.ts";

const choiceKey = z.strictObject({ acceptedChoice: z.string() });

export const choiceKeyEvaluator: EvaluatorRegistration = {
  id: "choice-key",
  version: 1,
  responseTypes: ["choice"],
  evaluate: ({ value, key }) => ({ status: "judged", correct: value === choiceKey.parse(key).acceptedChoice }),
};
