import { z } from "zod";
import { defineResponseType, LearningError } from "../src/server.ts";
import type { EvaluatorRegistration } from "../src/server.ts";
import { responseTypeContract } from "./fixtures/contracts/response-type-contract.ts";
import type { ResponseTypeRow } from "./fixtures/contracts/response-type-contract.ts";

const judgeKey = z.strictObject({ acceptedResponse: z.boolean() });
const judgeEvaluator: EvaluatorRegistration = {
  id: "judge-reference", version: 1, responseTypes: ["booleanOrString"],
  evaluate: ({ value, key }) => ({ status: "judged", correct: value !== null && value === judgeKey.parse(key).acceptedResponse }),
};

const multiKey = z.strictObject({ acceptedIndexes: z.array(z.int()) });
const multiEvaluator: EvaluatorRegistration = {
  id: "multi-reference", version: 1, responseTypes: ["optionIndexArray"],
  evaluate({ value, key }) {
    const accepted = new Set(multiKey.parse(key).acceptedIndexes);
    const chosen = new Set(z.array(z.int()).nullable().parse(value) ?? []);
    return { status: "judged", correct: chosen.size === accepted.size && [...accepted].every(index => chosen.has(index)) };
  },
};

const ids = z.array(z.string());
const pairs = z.record(z.string(), z.string());
const matchingResponse = defineResponseType({
  id: "hostMatching",
  version: 1,
  config: ["left", "right"],
  validateQuestion(question, issue) {
    if (!ids.min(1).safeParse(question.left).success) issue(["left"], "须冻结左列");
    if (!ids.min(1).safeParse(question.right).success) issue(["right"], "须冻结右列");
  },
  parseValue(value, question) {
    const parsed = pairs.safeParse(value);
    const left = ids.parse(question.left);
    const right = ids.parse(question.right);
    if (!parsed.success || Object.entries(parsed.data).some(([from, to]) => !left.includes(from) || !right.includes(to))) {
      throw new LearningError(422, "INVALID_RESPONSE");
    }
    return parsed.data;
  },
  isAnswered: value => Object.keys(value).length > 0,
});
const orderingResponse = defineResponseType({
  id: "hostOrdering",
  version: 1,
  config: ["items"],
  validateQuestion(question, issue) {
    if (!ids.min(2).safeParse(question.items).success) issue(["items"], "须冻结至少两项");
  },
  parseValue(value, question) {
    const parsed = ids.safeParse(value);
    const items = ids.parse(question.items);
    if (!parsed.success || parsed.data.some(item => !items.includes(item)) || new Set(parsed.data).size !== parsed.data.length) {
      throw new LearningError(422, "INVALID_RESPONSE");
    }
    return parsed.data;
  },
  isAnswered: value => value.length > 0,
});

const needsReview = { status: "needsReview" } as const;
const correct = { status: "judged", correct: true } as const;
const wrong = { status: "judged", correct: false } as const;

function textRow(row: string, id: string, prompt: string): ResponseTypeRow {
  return {
    row, question: { id, version: 2, prompt, response: "textWithOptionalTitle" }, grading: { path: "teacherReview" },
    answers: [{ value: { body: "设甲为 x，列方程得 x = 4。", title: "解" }, result: needsReview }, { value: { body: "答案是 5。" }, result: needsReview }],
    unansweredDraft: { body: "   ", title: "解" }, missingDraft: needsReview,
  };
}

const rows: readonly ResponseTypeRow[] = [
  {
    row: "T-judge",
    question: { id: "judge", version: 3, prompt: "这句话成立吗？", response: "booleanOrString", options: { yes: "是", no: "否" } },
    grading: { path: "automatic", evaluator: judgeEvaluator, register: judgeEvaluator, key: { acceptedResponse: true } },
    answers: [{ value: true, result: correct }, { value: false, result: wrong }],
    missingDraft: wrong,
  },
  {
    row: "T-choice",
    question: { id: "choice", version: 1, prompt: "选出正确项。", response: "choice", options: { a: "甲", b: "乙", c: "丙" } },
    grading: { path: "automatic", evaluator: { id: "choice-key", version: 1 }, key: { acceptedChoice: "b" } },
    answers: [{ value: "b", result: correct }, { value: "c", result: wrong }],
    missingDraft: wrong,
  },
  {
    row: "T-multi",
    question: { id: "multi", version: 1, prompt: "选出所有正确项。", response: "optionIndexArray", options: { 0: "甲", 1: "乙", 2: "丙" } },
    grading: { path: "automatic", evaluator: multiEvaluator, register: multiEvaluator, key: { acceptedIndexes: [0, 2] } },
    answers: [{ value: [2, 0], result: correct }, { value: [0], result: wrong }, { value: [0, 1, 2], result: wrong }],
    unansweredDraft: [],
    missingDraft: wrong,
  },
  {
    row: "T-fill",
    question: { id: "fill", version: 1, prompt: "填出两个空。", response: "orderedTextBlanks", blankCount: 2 },
    grading: { path: "teacherReview" },
    answers: [{ value: ["4", "5"], result: needsReview }, { value: ["4", ""], result: needsReview }],
    unansweredDraft: ["", "  "],
    missingDraft: needsReview,
  },
  textRow("T-solve", "solve", "写出解答过程与最终答案。"),
  textRow("T-apply", "apply", "用所学方法解决实际问题。"),
  textRow("T-find-error", "find-error", "找出并改正解答中的错误。"),
  {
    row: "T-matching",
    question: { id: "matching", version: 1, prompt: "把左右两列配对。", response: "hostMatching", left: ["l1", "l2"], right: ["r1", "r2"] },
    responseTypes: [matchingResponse], grading: { path: "teacherReview" },
    answers: [{ value: { l1: "r2", l2: "r1" }, result: needsReview }, { value: { l1: "r1" }, result: needsReview }],
    unansweredDraft: {},
    missingDraft: needsReview,
  },
  {
    row: "T-ordering",
    question: { id: "ordering", version: 1, prompt: "按先后排序。", response: "hostOrdering", items: ["a", "b", "c"] },
    responseTypes: [orderingResponse], grading: { path: "teacherReview" },
    answers: [{ value: ["c", "a", "b"], result: needsReview }, { value: ["a"], result: needsReview }],
    unansweredDraft: [],
    missingDraft: needsReview,
  },
  textRow("T-response", "response", "回答问题并说明理由。"),
];

for (const row of rows) responseTypeContract(row);
