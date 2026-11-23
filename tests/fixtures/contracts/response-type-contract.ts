import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { EvaluatorRegistration, QuestionDeliveryDraftInput, RegisteredResponseType, VerdictResult } from "../../../src/server.ts";
import { scenarioDatabase } from "../online-reading.ts";
import {
  deliveryInput, deliveryPublication, override, recoveryKey, reviewer, openRuntime, saveDraft, startFor, withdraw,
} from "./delivery.ts";
import type { Activity, ContractQuestion, Runtime } from "./delivery.ts";

export type VerdictSample = Readonly<{ name: string; value: QuestionDeliveryDraftInput["value"]; expected: VerdictResult }>;

type Grading =
  | Readonly<{ mode: "automatic"; key: Readonly<Record<string, unknown>>; evaluator: EvaluatorRegistration }>
  | Readonly<{ mode: "teacherReview"; evaluator?: EvaluatorRegistration }>;

export type ResponseTypeContract = Readonly<{
  row: string;
  question: ContractQuestion;
  grading: Grading;
  responseTypes?: readonly RegisteredResponseType[];
  samples: readonly [VerdictSample, ...VerdictSample[]];
  unanswered: Readonly<{ expected: VerdictResult; blank?: QuestionDeliveryDraftInput["value"] }>;
}>;

type Observation = Readonly<{ status: "judged"; correct: boolean; source: "automatic" | "teacherReview" }> | Readonly<{ status: "needsReview" }>;

function expectedObservation(result: VerdictResult): Observation {
  return result.status === "judged" ? { status: "judged", correct: result.correct, source: "automatic" } : { status: "needsReview" };
}

function countingEvaluator(registration: EvaluatorRegistration | undefined, calls: { count: number }) {
  if (!registration) return [];
  return [{ ...registration, evaluate: (input: Parameters<EvaluatorRegistration["evaluate"]>[0]) => {
    calls.count++;
    return registration.evaluate(input);
  } }];
}

function world(t: TestContext, contract: ResponseTypeContract) {
  const calls = { count: 0 };
  const runtime = openRuntime(scenarioDatabase(t), {
    responseTypes: [...contract.responseTypes ?? []], evaluators: countingEvaluator(contract.grading.evaluator, calls), authorizeReview: () => true,
  });
  t.after(() => runtime.close());
  const publish = (id: string, allowUnanswered: boolean) => {
    const { question, grading } = contract;
    const keys = grading.mode === "automatic" ? { [question.id]: grading.key } : {};
    const teacherReview = grading.mode === "teacherReview" ? [question.id] : [];
    runtime.publish(deliveryPublication({ id, questions: [question], grading: { keys, teacherReview }, mode: "whole", allowUnanswered }));
    return id;
  };
  return { runtime, calls, publish };
}

function learner(contract: ResponseTypeContract, label: string) {
  return { role: "student", id: `${contract.row}-${label}` } as const;
}

function handIn(runtime: Runtime, practiceId: string, contract: ResponseTypeContract, label: string, value?: QuestionDeliveryDraftInput["value"]) {
  const principal = learner(contract, label);
  const activity = startFor(runtime, practiceId, principal);
  const revision = value === undefined ? 0 : saveDraft(runtime, activity, contract.question, value, { principal }).revision;
  const input = deliveryInput(activity, "whole", [{ question: contract.question, revision }], `hand-in-${label}`);
  const receipt = runtime.confirmQuestionDelivery(principal, activity.activityId, input);
  return { principal, activity, input, receipt, key: recoveryKey(input) };
}

function observe(runtime: Runtime, activity: Activity, key: ReturnType<typeof recoveryKey>): Observation & { revision: number } {
  const [question, ...rest] = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts").questions;
  assert.ok(question && rest.length === 0);
  if (question.status === "needsReview") return { status: "needsReview", revision: question.revision };
  assert.equal(question.status, "judged");
  assert.ok(question.effective);
  return { status: "judged", correct: question.effective.correct, source: question.effective.source, revision: question.revision };
}

function withoutRevision({ revision: _revision, ...observation }: Observation & { revision: number }) {
  return observation;
}

function expectedCalls(contract: ResponseTypeContract, deliveries: number) {
  return contract.grading.mode === "automatic" ? deliveries : 0;
}

export function responseTypeContract(contract: ResponseTypeContract) {
  const { row } = contract;

  test(`${row}｜①判分：冻结题与私有键下，每个样例值得到约定判定，读面一致`, t => {
    const { runtime, calls, publish } = world(t, contract);
    const practiceId = publish(`${row}-verdict`, false);
    for (const [index, sample] of contract.samples.entries()) {
      const delivered = handIn(runtime, practiceId, contract, `sample-${index}`, sample.value);
      runtime.evaluatePending();
      assert.deepEqual(withoutRevision(observe(runtime, delivered.activity, delivered.key)), expectedObservation(sample.expected), sample.name);
      const recovered = runtime.recoverQuestionDelivery(delivered.principal, delivered.activity.activityId, delivered.key, "declared");
      assert.deepEqual(recovered.receipt, delivered.receipt);
      assert.deepEqual(recovered.confirmation.questions.map(({ value }) => value), [sample.value]);
    }
    assert.equal(calls.count, expectedCalls(contract, contract.samples.length));
  });

  test(`${row}｜②空答：缺稿按未答判定，已答规则区分空值与作答`, t => {
    const { runtime, calls, publish } = world(t, contract);
    const optional = publish(`${row}-optional`, true);
    const missing = handIn(runtime, optional, contract, "missing");
    runtime.evaluatePending();
    assert.deepEqual(withoutRevision(observe(runtime, missing.activity, missing.key)), expectedObservation(contract.unanswered.expected));
    const required = publish(`${row}-required`, false);
    const { blank } = contract.unanswered;
    let deliveries = 1;
    if (blank !== undefined) {
      const principal = learner(contract, "blank-required");
      const activity = startFor(runtime, required, principal);
      const saved = saveDraft(runtime, activity, contract.question, blank, { principal });
      assert.throws(() => runtime.confirmQuestionDelivery(principal, activity.activityId,
        deliveryInput(activity, "whole", [{ question: contract.question, revision: saved.revision }], "blank")),
      { status: 422, code: "UNANSWERED_QUESTION" });
      assert.equal(runtime.read(principal, activity.activityId).status, "active");
      const allowed = handIn(runtime, optional, contract, "blank-optional", blank);
      runtime.evaluatePending();
      assert.deepEqual(withoutRevision(observe(runtime, allowed.activity, allowed.key)), expectedObservation(contract.unanswered.expected));
      deliveries++;
    }
    for (const [index, sample] of contract.samples.entries()) {
      const answered = handIn(runtime, required, contract, `answered-${index}`, sample.value);
      assert.equal(runtime.read(answered.principal, answered.activity.activityId).status, "completed", sample.name);
    }
    runtime.evaluatePending();
    assert.equal(calls.count, expectedCalls(contract, deliveries + contract.samples.length));
  });

  test(`${row}｜③改判/清除：教师改判即生效，逐次清除回落到上一条改判，再回落到自动判定或待批`, t => {
    const { runtime, publish } = world(t, contract);
    const practiceId = publish(`${row}-amend`, false);
    const [sample] = contract.samples;
    const { principal, activity, receipt, key } = handIn(runtime, practiceId, contract, "amend", sample.value);
    runtime.evaluatePending();
    const baseline = observe(runtime, activity, key);
    const studentBefore = runtime.recoverQuestionDelivery(principal, activity.activityId, key, "declared");
    const location = { receipt, questionId: contract.question.id };
    const write = (command: Parameters<Runtime["writeQuestionDeliveryVerdict"]>[3]) =>
      runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command);
    const first = write(override({ ...location, operationId: "first", expectedRevision: baseline.revision }, false));
    assert.deepEqual(observe(runtime, activity, key), { status: "judged", correct: false, source: "teacherReview", revision: first.revision });
    assert.deepEqual(write(override({ ...location, operationId: "first", expectedRevision: baseline.revision }, false)), first);
    const second = write(override({ ...location, operationId: "second", expectedRevision: first.revision }, true));
    assert.deepEqual(observe(runtime, activity, key), { status: "judged", correct: true, source: "teacherReview", revision: second.revision });
    assert.throws(() => write(withdraw({ ...location, operationId: "stale", expectedRevision: first.revision }, second.id)), { code: "VERDICT_CONFLICT" });
    const cleared = write(withdraw({ ...location, operationId: "clear-second", expectedRevision: second.revision }, second.id));
    assert.deepEqual(observe(runtime, activity, key), { status: "judged", correct: false, source: "teacherReview", revision: cleared.revision });
    const reverted = write(withdraw({ ...location, operationId: "clear-first", expectedRevision: cleared.revision }, first.id));
    assert.deepEqual(observe(runtime, activity, key), { ...withoutRevision(baseline), revision: reverted.revision });
    assert.deepEqual(runtime.recoverQuestionDelivery(principal, activity.activityId, key, "declared"), studentBefore);
    assert.doesNotMatch(JSON.stringify(runtime.read(principal, activity.activityId)), /契约复核|teacherReview|acceptedByQuestion/);
  });
}
