import { z } from "zod";
import { LearningError } from "../../contracts/learning-error.ts";
import { defineResponseType } from "../../contracts/response-type.ts";
import { requireOptions } from "./question-shape.ts";

const raw = z.union([z.boolean(), z.string()]);
const booleanKey = z.strictObject({ acceptedResponse: z.boolean() });

export const booleanOrStringResponse = defineResponseType({
  id: "booleanOrString",
  version: 1,
  validateQuestion: requireOptions,
  parseValue(value) {
    const parsed = raw.safeParse(value);
    if (!parsed.success) throw new LearningError(422, "INVALID_RESPONSE");
    return parsed.data;
  },
  isAnswered: () => true,
  parseKey: key => booleanKey.safeParse(key).data,
  wholePaperKey: { field: "acceptedResponses", toKey: acceptedResponse => ({ acceptedResponse }) },
});
