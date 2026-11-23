import { z } from "zod";
import { LearningError } from "../../contracts/learning-error.ts";
import { defineResponseType } from "../../contracts/response-type.ts";
import type { QuestionDefinition } from "../../contracts/response-type.ts";
import { requireOptions } from "./question-shape.ts";

const indexes = z.array(z.int().nonnegative());
const indexKey = z.strictObject({ acceptedIndexes: indexes.min(1) });

function withinOptions(values: readonly number[], question: QuestionDefinition) {
  return values.every(index => Object.hasOwn(question.options, String(index)));
}

export const optionIndexArrayResponse = defineResponseType({
  id: "optionIndexArray",
  version: 1,
  validateQuestion(question, issue) {
    requireOptions(question, issue);
    if (Object.keys(question.options).some((id, position) => id !== String(position))) {
      issue(["options"], "索引题须冻结从零连续编号的选项");
    }
  },
  parseValue(value, question) {
    const parsed = indexes.safeParse(value);
    if (!parsed.success || !withinOptions(parsed.data, question)) throw new LearningError(422, "INVALID_OPTION_INDEX");
    return parsed.data;
  },
  isAnswered: value => value.length > 0,
  parseKey(key, question) {
    const parsed = indexKey.safeParse(key);
    return parsed.success && withinOptions(parsed.data.acceptedIndexes, question) ? parsed.data : undefined;
  },
  wholePaperKey: { field: "acceptedIndexes", toKey: acceptedIndexes => ({ acceptedIndexes }) },
});
