import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { QuestionGrading, QuestionGradingFacts } from "../../src/contracts/grading-policy.ts";
import type { QuestionDeliveryDraftInput } from "../../src/server.ts";
import { resolveGradingPolicy, routeQuestions } from "../../src/kernel/grading-policy.ts";
import { choiceEvaluator, combinedEvaluator, indexEvaluator } from "../fixtures/evaluators.ts";
import { deliveryInput, deliveryPublication, evaluatorRef, openRuntime, recoveryKey, reviewer, saveDraft, startFor, student } from "../fixtures/contracts/delivery.ts";
import type { ContractQuestion } from "../fixtures/contracts/delivery.ts";
import { ownClassJudgeEvaluator } from "../fixtures/contracts/ownclass-evaluators.ts";
import { scenarioDatabase } from "../fixtures/online-reading.ts";

type Outcome = Readonly<{ handler: "automatic"; correct: boolean }> | Readonly<{ handler: "teacherPending" | "selfReviewPending" }>;
type LegacyQuestion = Readonly<{
  question: ContractQuestion;
  facts: QuestionGradingFacts;
  key?: Readonly<Record<string, unknown>>;
  value?: QuestionDeliveryDraftInput["value"];
  legacy: Outcome;
}>;

const auto = (correct: boolean): Outcome => ({ handler: "automatic", correct });
const teacherPending: Outcome = { handler: "teacherPending" };
const keyed = { automatic: true, reference: true };
const referenced = { automatic: false, reference: true };
const judge = (id: string) => ({ id, version: 1, prompt: "判断。", response: "booleanOrString", options: { true: "正确", false: "错误" } });
const choice = (id: string) => ({ id, version: 1, prompt: "单选。", response: "choice", options: { "0": "A", "1": "B", "2": "C", "3": "D" } });
const multi = { id: "练习四-3", version: 1, prompt: "多选。", response: "optionIndexArray", options: { "0": "A", "1": "B", "2": "C", "3": "D" } };
const blanks = (id: string, blankCount: number) => ({ id, version: 1, prompt: "填空。", response: "orderedTextBlanks", blankCount });
const written = (id: string) => ({ id, version: 1, prompt: "写出过程与最终答案。", response: "textWithOptionalTitle" });

const partialPaper: readonly LegacyQuestion[] = [
  { question: judge("练习四-1"), facts: keyed, key: { acceptedResponse: true }, value: true, legacy: auto(true) },
  { question: choice("练习四-2"), facts: keyed, key: { acceptedChoice: "1" }, legacy: auto(false) },
  { question: multi, facts: keyed, key: { acceptedIndexes: [0, 2] }, value: [0], legacy: auto(false) },
  { question: blanks("练习四-4", 3), facts: referenced, value: ["4", "-6", "0.5"], legacy: teacherPending },
  { question: blanks("练习四-5", 1), facts: referenced, legacy: teacherPending },
  { question: written("p4-q7"), facts: referenced, value: { body: "-3" }, legacy: auto(true) },
  { question: written("练习四-7"), facts: referenced, legacy: teacherPending },
  { question: written("练习四-8"), facts: referenced, legacy: teacherPending },
];

const allCorrectPaper: readonly LegacyQuestion[] = [
  { question: judge("练习四-1"), facts: keyed, key: { acceptedResponse: true }, value: true, legacy: auto(true) },
  { question: choice("练习四-2"), facts: keyed, key: { acceptedChoice: "1" }, value: "1", legacy: auto(true) },
  { question: multi, facts: keyed, key: { acceptedIndexes: [0, 2] }, value: [0, 2], legacy: auto(true) },
  { question: judge("练习四-4"), facts: keyed, key: { acceptedResponse: true }, value: true, legacy: auto(true) },
  { question: choice("练习四-5"), facts: keyed, key: { acceptedChoice: "2" }, value: "2", legacy: auto(true) },
  { question: written("p4-q7"), facts: referenced, value: { body: "-3" }, legacy: auto(true) },
  { question: written("练习四-7"), facts: referenced, value: { body: "1.4" }, legacy: auto(true) },
  { question: written("练习四-8"), facts: referenced, value: { body: "第一步开始出错：应取绝对值较大的加数的符号，得 -5。" }, legacy: auto(true) },
];

const evaluators = [combinedEvaluator(ownClassJudgeEvaluator(evaluatorRef),
  choiceEvaluator(evaluatorRef, ({ choice: selected, acceptedChoice }) => selected === acceptedChoice),
  indexEvaluator(evaluatorRef, ({ value, acceptedIndexes }) => ({ status: "judged", correct: value !== null
    && value.length === acceptedIndexes.length && acceptedIndexes.every(index => value.includes(index)) })))];

function replay(t: TestContext, practiceId: string, paper: readonly LegacyQuestion[]) {
  const runtime = openRuntime(scenarioDatabase(t), { evaluators, authorizeReview: () => true });
  t.after(() => runtime.close());
  const { policy, fallbacks } = resolveGradingPolicy(null);
  assert.deepEqual(fallbacks, ["version", "withReference"]);
  const routed = routeQuestions(policy, paper.map(({ question, facts }) => ({ id: question.id, facts })));
  const keys = Object.fromEntries(paper.flatMap(({ question, key }) => key ? [[question.id, key]] : []));
  runtime.publish(deliveryPublication({ id: practiceId, questions: paper.map(({ question }) => question), mode: "whole", allowUnanswered: true,
    grading: { keys, teacherReview: [...routed.selfReview, ...routed.teacherReview] } }));
  const activity = startFor(runtime, practiceId);
  const handed = paper.map(({ question, value }) => ({ question,
    revision: value === undefined ? 0 : saveDraft(runtime, activity, question, value).revision }));
  const input = deliveryInput(activity, "whole", handed, "legacy-hand-in");
  runtime.confirmQuestionDelivery(student, activity.activityId, input);
  runtime.evaluatePending();
  const handlers: readonly QuestionGrading[] = ["automatic", "selfReview", "teacherReview"];
  const handlerOf = new Map(handlers.flatMap(handler => routed[handler].map(questionId => [questionId, handler] as const)));
  return runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input), "verdicts").questions.map((question): [string, Outcome] => {
    const handler = handlerOf.get(question.questionId);
    if (handler === "automatic") {
      assert.ok(question.status === "judged" && question.effective);
      return [question.questionId, auto(question.effective.correct)];
    }
    assert.equal(question.status, "needsReview");
    return [question.questionId, { handler: handler === "selfReview" ? "selfReviewPending" : "teacherPending" }];
  });
}

function differences(paper: readonly LegacyQuestion[], replayed: readonly [string, Outcome][]) {
  const now = new Map(replayed);
  assert.deepEqual([...now.keys()], paper.map(({ question }) => question.id));
  return paper.flatMap(({ question, legacy }) => {
    const current = now.get(question.id);
    return current && JSON.stringify(current) !== JSON.stringify(legacy) ? [{ questionId: question.id, legacy, now: current }] : [];
  });
}

const selfReviewPending: Outcome = { handler: "selfReviewPending" };

test("旧样例「部分错/未答组合」策略为空：按默认策略重跑，客观三题与旧版一致，五道有参考题由旧语义改为学生自评待批", t => {
  assert.deepEqual(differences(partialPaper, replay(t, "legacy-partial", partialPaper)), [
    { questionId: "练习四-4", legacy: teacherPending, now: selfReviewPending },
    { questionId: "练习四-5", legacy: teacherPending, now: selfReviewPending },
    { questionId: "p4-q7", legacy: auto(true), now: selfReviewPending },
    { questionId: "练习四-7", legacy: teacherPending, now: selfReviewPending },
    { questionId: "练习四-8", legacy: teacherPending, now: selfReviewPending },
  ]);
});

test("旧样例「全对组合」策略为空：按默认策略重跑，五道客观题与旧版一致，解答、应用、找错三题由自动判对改为学生自评待批", t => {
  assert.deepEqual(differences(allCorrectPaper, replay(t, "legacy-all-correct", allCorrectPaper)), [
    { questionId: "p4-q7", legacy: auto(true), now: selfReviewPending },
    { questionId: "练习四-7", legacy: auto(true), now: selfReviewPending },
    { questionId: "练习四-8", legacy: auto(true), now: selfReviewPending },
  ]);
});
