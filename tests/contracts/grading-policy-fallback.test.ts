import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultGradingPolicy, gradingPolicy } from "../../src/contracts/grading-policy.ts";
import type { GradingPolicy, GradingPolicyField, QuestionGrading } from "../../src/contracts/grading-policy.ts";
import { questionGrading, resolveGradingPolicy, routeQuestions } from "../../src/kernel/grading-policy.ts";
import { combinedEvaluator, titledTextEvaluator } from "../fixtures/evaluators.ts";
import { deliveryInput, deliveryPublication, evaluatorRef, openRuntime, reviewer, saveDraft, startFor, recoveryKey } from "../fixtures/contracts/delivery.ts";
import type { ContractQuestion } from "../fixtures/contracts/delivery.ts";
import { ownClassJudgeEvaluator } from "../fixtures/contracts/ownclass-evaluators.ts";
import { scenarioDatabase } from "../fixtures/online-reading.ts";

const teacherOnly: GradingPolicy = { version: 1, withReference: "teacherReview" };
const everyField: GradingPolicyField[] = ["version", "withReference"];

type FallbackCase = Readonly<{ name: string; declared: unknown; policy: GradingPolicy; fallbacks: readonly GradingPolicyField[] }>;
const cases: readonly FallbackCase[] = [
  { name: "空策略：未声明", declared: undefined, policy: defaultGradingPolicy, fallbacks: everyField },
  { name: "空策略：null", declared: null, policy: defaultGradingPolicy, fallbacks: everyField },
  { name: "全缺：空对象", declared: {}, policy: defaultGradingPolicy, fallbacks: everyField },
  { name: "全缺：只有未知字段", declared: { gradingPolicy: "auto" }, policy: defaultGradingPolicy, fallbacks: everyField },
  { name: "只缺 version", declared: { withReference: "teacherReview" }, policy: teacherOnly, fallbacks: ["version"] },
  { name: "只缺 withReference", declared: { version: 1 }, policy: defaultGradingPolicy, fallbacks: ["withReference"] },
  { name: "非法：整份策略是字符串", declared: "reference_self", policy: defaultGradingPolicy, fallbacks: everyField },
  { name: "非法：整份策略是数组", declared: [teacherOnly], policy: defaultGradingPolicy, fallbacks: everyField },
  { name: "非法：version 类型错", declared: { ...teacherOnly, version: "1" }, policy: teacherOnly, fallbacks: ["version"] },
  { name: "非法：version 未知取值", declared: { ...teacherOnly, version: 2 }, policy: teacherOnly, fallbacks: ["version"] },
  { name: "非法：withReference 类型错", declared: { version: 1, withReference: true }, policy: defaultGradingPolicy, fallbacks: ["withReference"] },
  { name: "非法：withReference 用旧产品档名", declared: { version: 1, withReference: "manual_only" }, policy: defaultGradingPolicy,
    fallbacks: ["withReference"] },
  { name: "合法：教师关闭自评", declared: teacherOnly, policy: teacherOnly, fallbacks: [] },
  { name: "合法：默认策略", declared: { ...defaultGradingPolicy }, policy: defaultGradingPolicy, fallbacks: [] },
];

test("兜底矩阵覆盖空策略、每次只缺一个字段、全缺、每个字段的类型错与未知取值", () => {
  for (const field of everyField) {
    const alone = cases.filter(({ fallbacks }) => fallbacks.length === 1 && fallbacks[0] === field);
    assert.ok(alone.some(({ name }) => name.startsWith("只缺")), `缺少只缺 ${field} 的用例`);
    assert.ok(alone.some(({ name }) => name.includes("类型错")), `缺少 ${field} 类型错的用例`);
    assert.ok(alone.filter(({ name }) => name.startsWith("非法")).length >= 2, `缺少 ${field} 未知取值的用例`);
  }
  assert.ok(cases.some(({ declared }) => declared === undefined) && cases.some(({ declared }) => declared === null));
});

test("兜得住①②：任何声明都回落成完整策略且不抛错，回落字段逐一记账，合法字段原样保留", () => {
  for (const { name, declared, policy, fallbacks } of cases) {
    const resolved = resolveGradingPolicy(declared);
    assert.deepEqual(resolved, { policy, fallbacks }, name);
    assert.deepEqual(gradingPolicy.parse(resolved.policy), resolved.policy, name);
  }
});

test("分流只看题的事实：能自动判的题恒交评估器，策略只能决定有参考题归自评还是教师，无参考题恒归教师", () => {
  for (const policy of [defaultGradingPolicy, teacherOnly]) {
    const route = (automatic: boolean, reference: boolean) => questionGrading(policy, { automatic, reference });
    assert.deepEqual([route(true, true), route(true, false), route(false, true), route(false, false)],
      ["automatic", "automatic", policy.withReference, "teacherReview"] satisfies QuestionGrading[]);
  }
});

const judged = { id: "judge", version: 1, prompt: "0 既不是正数也不是负数。", response: "booleanOrString", options: { true: "对", false: "错" } };
const unkeyed = { ...judged, id: "judge-unkeyed", prompt: "没有登记答案的判断题。" };
const solve = { id: "solve", version: 1, prompt: "解方程并写出最终答案。", response: "textWithOptionalTitle" };
const essay = { id: "essay", version: 1, prompt: "说说你的想法。", response: "textWithOptionalTitle" };
const paper = [
  { question: judged, facts: { automatic: true, reference: true }, value: false, key: { acceptedResponse: true } },
  { question: unkeyed, facts: { automatic: false, reference: false }, value: true },
  { question: solve, facts: { automatic: false, reference: true }, value: { body: "x = -3" } },
  { question: essay, facts: { automatic: false, reference: false }, value: { body: "先找同号。" } },
] satisfies readonly { question: ContractQuestion; facts: { automatic: boolean; reference: boolean }; value: unknown; key?: object }[];

test("兜得住③：每种声明下，混合卷经真实确认与评估后每道题要么判出对错要么进待批，只有带私有键的可判题调用评估器", t => {
  const seen: string[] = [];
  const spy = combinedEvaluator(ownClassJudgeEvaluator(evaluatorRef), titledTextEvaluator(evaluatorRef, () => ({ status: "judged", correct: true })));
  const runtime = openRuntime(scenarioDatabase(t), { authorizeReview: () => true,
    evaluators: [{ ...spy, evaluate: input => { seen.push(input.questionId); return spy.evaluate(input); } }] });
  t.after(() => runtime.close());
  for (const [index, { name, declared }] of cases.entries()) {
    const { policy } = resolveGradingPolicy(declared);
    const routed = routeQuestions(policy, paper.map(({ question, facts }) => ({ id: question.id, facts })));
    assert.deepEqual(routed, { automatic: [judged.id], selfReview: policy.withReference === "selfReview" ? [solve.id] : [],
      teacherReview: policy.withReference === "selfReview" ? [unkeyed.id, essay.id] : [unkeyed.id, solve.id, essay.id] }, name);
    const practiceId = `fallback-${index}`;
    const keys = Object.fromEntries(paper.flatMap(({ question, key }) => key && routed.automatic.includes(question.id) ? [[question.id, key]] : []));
    runtime.publish(deliveryPublication({ id: practiceId, questions: paper.map(({ question }) => question), mode: "whole", allowUnanswered: true,
      grading: { keys, teacherReview: [...routed.selfReview, ...routed.teacherReview] } }));
    const principal = { role: "student", id: `fallback-learner-${index}` } as const;
    const activity = startFor(runtime, practiceId, principal);
    const handed = paper.map(({ question, value }) => ({ question, revision: saveDraft(runtime, activity, question, value, { principal }).revision }));
    const input = deliveryInput(activity, "whole", handed, "hand-in");
    runtime.confirmQuestionDelivery(principal, activity.activityId, input);
    seen.length = 0;
    runtime.evaluatePending();
    assert.deepEqual(seen, [judged.id], name);
    const verdicts = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input), "verdicts").questions
      .map(question => ({ questionId: question.questionId, status: question.status,
        effective: "effective" in question ? question.effective : undefined }));
    assert.deepEqual(verdicts, [
      { questionId: judged.id, status: "judged", effective: { source: "automatic", correct: false } },
      { questionId: unkeyed.id, status: "needsReview", effective: undefined },
      { questionId: solve.id, status: "needsReview", effective: undefined },
      { questionId: essay.id, status: "needsReview", effective: undefined },
    ], name);
  }
});
