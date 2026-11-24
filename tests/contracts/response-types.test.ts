import { z } from "zod";
import { defineResponseType, LearningError } from "../../src/server.ts";
import { choiceEvaluator, indexEvaluator, titledTextEvaluator } from "../fixtures/evaluators.ts";
import { evaluatorRef } from "../fixtures/contracts/delivery.ts";
import { ownClassJudgeEvaluator } from "../fixtures/contracts/ownclass-evaluators.ts";
import { responseTypeContract } from "../fixtures/contracts/response-type-contract.ts";

responseTypeContract({
  row: "T-judge",
  question: { id: "judge", version: 1, prompt: "-3 与 3 互为相反数。", response: "booleanOrString", options: { true: "对", false: "错" } },
  grading: { name: "自动判", mode: "automatic", key: { acceptedResponse: true }, evaluator: ownClassJudgeEvaluator(evaluatorRef) },
  samples: [
    { name: "判对", value: true, expected: { status: "judged", correct: true } },
    { name: "判错", value: false, expected: { status: "judged", correct: false } },
  ],
  unanswered: { expected: { status: "judged", correct: false } },
});

responseTypeContract({
  row: "T-solve",
  question: { id: "solve", version: 1, prompt: "解方程 2x + 6 = 0，写出过程和最终答案。", response: "textWithOptionalTitle" },
  grading: { name: "教师评阅", mode: "teacherReview", evaluator: titledTextEvaluator(evaluatorRef, () => ({ status: "judged", correct: true })) },
  samples: [
    { name: "有过程与最终答案", value: { body: "2x = -6，x = -3", title: "最终答案" }, expected: { status: "needsReview" } },
    { name: "只有正文", value: { body: "x = 2" }, expected: { status: "needsReview" } },
  ],
  unanswered: { expected: { status: "needsReview" }, blank: { body: "   ", title: "附注" } },
});

// —— 其余 8 行（由 PR #8 的数据行迁入本夹具；判分路径与 OwnClass 冻结策略一致：choice / multi 自动判，其余教师评阅）——
const correct = { status: "judged", correct: true } as const;
const wrong = { status: "judged", correct: false } as const;
const needsReview = { status: "needsReview" } as const;
const teacherReview = { name: "教师评阅", mode: "teacherReview" } as const;

responseTypeContract({
  row: "T-choice",
  question: { id: "choice", version: 1, prompt: "选出正确项。", response: "choice", options: { a: "甲", b: "乙", c: "丙" } },
  grading: { name: "自动判", mode: "automatic", key: { acceptedChoice: "b" },
    evaluator: choiceEvaluator(evaluatorRef, ({ choice, acceptedChoice }) => choice === acceptedChoice) },
  samples: [{ name: "选对", value: "b", expected: correct }, { name: "选错", value: "c", expected: wrong }],
  unanswered: { expected: wrong },
});

responseTypeContract({
  row: "T-multi",
  question: { id: "multi", version: 1, prompt: "选出所有正确项。", response: "optionIndexArray", options: { 0: "甲", 1: "乙", 2: "丙" } },
  grading: { name: "自动判", mode: "automatic", key: { acceptedIndexes: [0, 2] },
    evaluator: indexEvaluator(evaluatorRef, ({ value, acceptedIndexes }) => {
      const chosen = new Set(value ?? []);
      return { status: "judged", correct: chosen.size === acceptedIndexes.length && acceptedIndexes.every(index => chosen.has(index)) };
    }) },
  samples: [
    { name: "全对（顺序无关）", value: [2, 0], expected: correct },
    { name: "漏选", value: [0], expected: wrong },
    { name: "多选", value: [0, 1, 2], expected: wrong },
  ],
  unanswered: { expected: wrong, blank: [] },
});

responseTypeContract({
  row: "T-fill",
  question: { id: "fill", version: 1, prompt: "填出两个空。", response: "orderedTextBlanks", blankCount: 2 },
  grading: teacherReview,
  samples: [{ name: "两空都填", value: ["4", "5"], expected: needsReview }, { name: "只填一空", value: ["4", ""], expected: needsReview }],
  unanswered: { expected: needsReview, blank: ["", "  "] },
});

for (const [row, id, prompt] of [
  ["T-apply", "apply", "用所学方法解决实际问题。"],
  ["T-find-error", "find-error", "找出并改正解答中的错误。"],
  ["T-response", "response", "回答问题并说明理由。"],
] as const) {
  responseTypeContract({
    row,
    question: { id, version: 1, prompt, response: "textWithOptionalTitle" },
    grading: teacherReview,
    samples: [
      { name: "带标题的解答", value: { body: "设甲为 x，列方程得 x = 4。", title: "解" }, expected: needsReview },
      { name: "只有正文", value: { body: "答案是 5。" }, expected: needsReview },
    ],
    unanswered: { expected: needsReview, blank: { body: "   ", title: "解" } },
  });
}

const ids = z.array(z.string());
const matchingResponse = defineResponseType({
  id: "hostMatching", version: 1, config: ["left", "right"],
  validateQuestion(question, issue) {
    if (!ids.min(1).safeParse(question.left).success) issue(["left"], "须冻结左列");
    if (!ids.min(1).safeParse(question.right).success) issue(["right"], "须冻结右列");
  },
  parseValue(value, question) {
    const parsed = z.record(z.string(), z.string()).safeParse(value);
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
  id: "hostOrdering", version: 1, config: ["items"],
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

responseTypeContract({
  row: "T-matching",
  question: { id: "matching", version: 1, prompt: "把左右两列配对。", response: "hostMatching", left: ["l1", "l2"], right: ["r1", "r2"] },
  responseTypes: [matchingResponse],
  grading: teacherReview,
  samples: [{ name: "全配", value: { l1: "r2", l2: "r1" }, expected: needsReview }, { name: "配一半", value: { l1: "r1" }, expected: needsReview }],
  unanswered: { expected: needsReview, blank: {} },
});

responseTypeContract({
  row: "T-ordering",
  question: { id: "ordering", version: 1, prompt: "按先后排序。", response: "hostOrdering", items: ["a", "b", "c"] },
  responseTypes: [orderingResponse],
  grading: teacherReview,
  samples: [{ name: "全排", value: ["c", "a", "b"], expected: needsReview }, { name: "只排一项", value: ["a"], expected: needsReview }],
  unanswered: { expected: needsReview, blank: [] },
});
