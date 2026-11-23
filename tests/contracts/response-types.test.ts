import { titledTextEvaluator } from "../fixtures/evaluators.ts";
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
