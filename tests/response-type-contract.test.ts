import { z } from "zod";
import type { EvaluatorRegistration } from "../src/server.ts";
import { responseTypeContract } from "./fixtures/contracts/response-type-contract.ts";
import type { ResponseTypeRow } from "./fixtures/contracts/response-type-contract.ts";

const judgeKey = z.strictObject({ acceptedResponse: z.boolean() });
const judgeEvaluator: EvaluatorRegistration = {
  id: "judge-reference", version: 1, responseTypes: ["booleanOrString"],
  evaluate: ({ value, key }) => ({ status: "judged", correct: value !== null && value === judgeKey.parse(key).acceptedResponse }),
};

const rows: readonly ResponseTypeRow[] = [
  {
    row: "T-judge",
    question: { id: "judge", version: 3, prompt: "这句话成立吗？", response: "booleanOrString", options: { yes: "是", no: "否" } },
    grading: { path: "automatic", evaluator: judgeEvaluator, register: judgeEvaluator, key: { acceptedResponse: true } },
    answers: [
      { value: true, result: { status: "judged", correct: true } },
      { value: false, result: { status: "judged", correct: false } },
    ],
    missingDraft: { status: "judged", correct: false },
  },
  {
    row: "T-solve",
    question: { id: "solve", version: 2, prompt: "写出解答过程与最终答案。", response: "textWithOptionalTitle" },
    grading: { path: "teacherReview" },
    answers: [
      { value: { body: "设甲为 x，列方程得 x = 4。", title: "解" }, result: { status: "needsReview" } },
      { value: { body: "答案是 5。" }, result: { status: "needsReview" } },
    ],
    unansweredDraft: { body: "   ", title: "解" },
    missingDraft: { status: "needsReview" },
  },
];

for (const row of rows) responseTypeContract(row);
