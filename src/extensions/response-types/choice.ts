import { z } from "zod";
import { LearningError } from "../../contracts/learning-error.ts";
import { defineResponseType } from "../../contracts/response-type.ts";
import { requireOptions } from "./question-shape.ts";

const choiceKey = z.strictObject({ acceptedChoice: z.string() });

export const choiceResponse = defineResponseType({
  id: "choice",
  version: 1,
  validateQuestion: requireOptions,
  parseValue(value, question) {
    if (typeof value !== "string" || !Object.hasOwn(question.options, value)) throw new LearningError(422, "INVALID_CHOICE");
    return value;
  },
  isAnswered: () => true,
  parseKey(key, question) {
    const parsed = choiceKey.safeParse(key);
    return parsed.success && Object.hasOwn(question.options, parsed.data.acceptedChoice) ? parsed.data : undefined;
  },
  wholePaperKey: { field: "acceptedChoices", toKey: acceptedChoice => ({ acceptedChoice }) },
});
