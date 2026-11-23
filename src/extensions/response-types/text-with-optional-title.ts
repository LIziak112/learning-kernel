import { z } from "zod";
import { LearningError } from "../../contracts/learning-error.ts";
import { defineResponseType } from "../../contracts/response-type.ts";
import { rejectOptions } from "./question-shape.ts";

const titledText = z.strictObject({ body: z.string(), title: z.string().optional() })
  .transform(({ body, title }): { body: string; title?: string } => title === undefined ? { body } : { body, title });
const noKey = z.strictObject({});

export const textWithOptionalTitleResponse = defineResponseType({
  id: "textWithOptionalTitle",
  version: 1,
  validateQuestion: rejectOptions,
  parseValue(value) {
    const parsed = titledText.safeParse(value);
    if (!parsed.success) throw new LearningError(422, "INVALID_RESPONSE");
    return parsed.data;
  },
  isAnswered: value => value.body.trim() !== "",
  parseKey: key => noKey.safeParse(key).data,
});
