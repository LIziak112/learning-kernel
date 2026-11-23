import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { EvaluatorRegistration, QuestionDeliveryDraftInput, RegisteredResponseType, VerdictResult } from "../../../src/server.ts";
import { scenarioDatabase } from "../online-reading.ts";
import {
  deliveryInput, deliveryPublication, override, recoveryKey, reviewer, openRuntime, saveDraft, startFor, withdraw,
} from "./delivery.ts";
import type { Activity, ContractQuestion, Runtime } from "./delivery.ts";

type DraftValue = QuestionDeliveryDraftInput["value"];
export type VerdictSample = Readonly<{ name: string; value: DraftValue; stored?: DraftValue; expected: VerdictResult }>;

export type ContractGradingMode =
  | Readonly<{ name: string; mode: "automatic"; key: Readonly<Record<string, unknown>>; evaluator: EvaluatorRegistration }>
  | Readonly<{ name: string; mode: "teacherReview"; evaluator?: EvaluatorRegistration }>;

export type ResponseTypeContract = Readonly<{
  row: string;
  question: ContractQuestion;
  grading: ContractGradingMode;
  responseTypes?: readonly RegisteredResponseType[];
  samples: readonly [VerdictSample, ...VerdictSample[]];
  unanswered: Readonly<{ expected: VerdictResult; blank?: DraftValue }>;
}>;

type Observation = Readonly<{ status: "judged"; correct: boolean; source: "automatic" | "teacherReview" }> | Readonly<{ status: "needsReview" }>;

function expectedObservation(result: VerdictResult): Observation {
  return result.status === "judged" ? { status: "judged", correct: result.correct, source: "automatic" } : { status: "needsReview" };
}

function stored(sample: VerdictSample) {
  return sample.stored === undefined ? sample.value : sample.stored;
}

function spiedEvaluators(registration: EvaluatorRegistration | undefined, seen: unknown[]): EvaluatorRegistration[] {
  if (!registration) return [];
  return [{ ...registration, evaluate: input => {
    seen.push(input.value);
    return registration.evaluate(input);
  } }];
}

function world(t: TestContext, contract: ResponseTypeContract) {
  const seen: unknown[] = [];
  const databasePath = scenarioDatabase(t);
  const { question, grading } = contract;
  const runtime = openRuntime(databasePath, {
    responseTypes: [...contract.responseTypes ?? []], evaluators: spiedEvaluators(grading.evaluator, seen), authorizeReview: () => true,
  });
  t.after(() => runtime.close());
  const publish = (id: string, allowUnanswered: boolean) => {
    const keys = grading.mode === "automatic" ? { [question.id]: grading.key } : {};
    const teacherReview = grading.mode === "teacherReview" ? [question.id] : [];
    const evaluator = grading.mode === "automatic" ? grading.evaluator : undefined;
    runtime.publish(deliveryPublication({
      id, questions: [question], grading: { keys, teacherReview }, mode: "whole", allowUnanswered,
      ...evaluator ? { evaluator: { id: evaluator.id, version: evaluator.version } } : {},
    }));
    return id;
  };
  const counts = (table: string) => {
    using database = new DatabaseSync(databasePath, { readOnly: true });
    return database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
  };
  return { runtime, seen, publish, counts };
}

function learner(contract: ResponseTypeContract, label: string) {
  return { role: "student", id: `${contract.row}-${label}` } as const;
}

function handIn(runtime: Runtime, practiceId: string, contract: ResponseTypeContract, label: string, value?: DraftValue) {
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

function assertEvaluated(contract: ResponseTypeContract, seen: readonly unknown[], values: readonly unknown[]) {
  assert.deepEqual(seen, contract.grading.mode === "automatic" ? values : []);
}

export function responseTypeContract(contract: ResponseTypeContract) {
  const label = `${contract.row}［${contract.grading.name}］`;

  test(`${label}｜①判分：冻结题与私有键下，每个样例值得到约定判定，读面一致`, t => {
    const { runtime, seen, publish, counts } = world(t, contract);
    const practiceId = publish("verdict", false);
    for (const [index, sample] of contract.samples.entries()) {
      const delivered = handIn(runtime, practiceId, contract, `sample-${index}`, sample.value);
      runtime.evaluatePending();
      assert.deepEqual(withoutRevision(observe(runtime, delivered.activity, delivered.key)), expectedObservation(sample.expected), sample.name);
      const recovered = runtime.recoverQuestionDelivery(delivered.principal, delivered.activity.activityId, delivered.key, "declared");
      assert.deepEqual(recovered.receipt, delivered.receipt);
      assert.deepEqual(recovered.confirmation.questions.map(({ value }) => value), [stored(sample)]);
    }
    assertEvaluated(contract, seen, contract.samples.map(stored));
    assert.deepEqual([counts("submissions"), counts("completions")], [contract.samples.length, contract.samples.length]);
  });

  test(`${label}｜②空答：缺稿按未答判定，已答规则区分空值与作答`, t => {
    const { runtime, seen, publish } = world(t, contract);
    const optional = publish("optional", true);
    const missing = handIn(runtime, optional, contract, "missing");
    runtime.evaluatePending();
    assert.deepEqual(withoutRevision(observe(runtime, missing.activity, missing.key)), expectedObservation(contract.unanswered.expected));
    const required = publish("required", false);
    const { blank } = contract.unanswered;
    const values: unknown[] = [null];
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
      values.push(blank);
    }
    for (const [index, sample] of contract.samples.entries()) {
      const answered = handIn(runtime, required, contract, `answered-${index}`, sample.value);
      assert.equal(runtime.read(answered.principal, answered.activity.activityId).status, "completed", sample.name);
      values.push(stored(sample));
    }
    runtime.evaluatePending();
    assertEvaluated(contract, seen, values);
  });

  test(`${label}｜③改判/清除：教师改判即生效，逐次清除回落到上一条改判，再回落到自动判定或待批`, t => {
    const { runtime, publish, counts } = world(t, contract);
    const practiceId = publish("amend", false);
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
    assert.equal(counts("verdict_events"), 4);
    assert.deepEqual(runtime.recoverQuestionDelivery(principal, activity.activityId, key, "declared"), studentBefore);
    assert.doesNotMatch(JSON.stringify(runtime.read(principal, activity.activityId)), /契约复核|teacherReview|acceptedByQuestion/);
  });
}
