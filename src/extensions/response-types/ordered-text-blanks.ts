import { z } from "zod";
import { LearningError } from "../../contracts/learning-error.ts";
import { defineResponseType } from "../../contracts/response-type.ts";
import type { QuestionDefinition } from "../../contracts/response-type.ts";
import { rejectOptions } from "./question-shape.ts";

const blanks = z.array(z.string());
const blankCount = z.int().nonnegative();
const blankKey = z.strictObject({ acceptedBlanks: z.array(z.array(z.string().min(1))).min(1) });

function frozenBlankCount(question: QuestionDefinition) {
  return blankCount.safeParse(question.blankCount).data;
}

export const orderedTextBlanksResponse = defineResponseType({
  id: "orderedTextBlanks",
  version: 1,
  config: ["blankCount"],
  validateQuestion(question, issue) {
    rejectOptions(question, issue);
    if (frozenBlankCount(question) === undefined) issue(["blankCount"], "须冻结非负整数空位数");
  },
  parseValue(value) {
    const parsed = blanks.safeParse(value);
    if (!parsed.success) throw new LearningError(422, "INVALID_RESPONSE");
    return parsed.data;
  },
  isAnswered: value => value.some(item => item.trim() !== ""),
  parseKey(key, question) {
    const parsed = blankKey.safeParse(key);
    return parsed.success && parsed.data.acceptedBlanks.length === frozenBlankCount(question) ? parsed.data : undefined;
  },
});
