import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import reading from "../practices/reading-library.json" with { type: "json" };
import {
  contractPolicy, deliveryInput, deliveryPublication, evaluatorRef, openRuntime, outsider, recoveryKey, saveDraft, startFor, student,
} from "./fixtures/contracts/delivery.ts";
import type { Activity, ContractQuestion, DeliveryDeclaration, Runtime } from "./fixtures/contracts/delivery.ts";
import { stubKeyFor, stubQuestion, stubResponse } from "./fixtures/contracts/scenario-contract.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";
import { readingPublicationSchema } from "../src/contracts/reading-publication.ts";
import type { EvaluatorRegistration, StudentActivity, StudentPrincipal } from "../src/server.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const restartPolicy: typeof contractPolicy = { ...contractPolicy, student: { ...contractPolicy.student, restart: "anytime" } };
const lesson: DeliveryDeclaration = {
  id: "restart-lesson", questions: [first, second], mode: "perQuestion", allowUnanswered: true,
  grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] }, policy: restartPolicy,
};
const evaluator: EvaluatorRegistration = {
  ...evaluatorRef, responseTypes: [stubResponse.id],
  evaluate: ({ value, key }) => ({ status: "judged", correct: value === Reflect.get(Object(key), "acceptedToken") }),
};
const shorter: DeliveryDeclaration = { ...lesson, version: 2, questions: [first], grading: { keys: { q1: stubKeyFor("甲") }, teacherReview: [] } };
function lineage(view: StudentActivity) {
  assert.ok("redoOf" in view);
  return view.redoOf;
}

const conflict = (code: string) => ({ status: 409, code });

function open(t: TestContext, path = scenarioDatabase(t)) {
  const runtime = openRuntime(path, { responseTypes: [stubResponse], evaluators: [evaluator] });
  let opened = true;
  t.after(() => { if (opened) runtime.close(); });
  return { ...runtime, close() { opened = false; runtime.close(); } };
}

function published(t: TestContext, declaration: DeliveryDeclaration = lesson) {
  const runtime = open(t);
  runtime.publish(deliveryPublication(declaration));
  return runtime;
}

function restart(runtime: Runtime, source: Activity, operationId: string, practiceVersion?: number, principal: StudentPrincipal = student) {
  return runtime.restart(principal, source.activityId, { protocolVersion: 1, operationId, ...practiceVersion ? { practiceVersion } : {} });
}

function handIn(runtime: Runtime, activity: Activity, question: ContractQuestion, value: string) {
  const draft = saveDraft(runtime, activity, question, value);
  const input = deliveryInput(activity, "question", [{ question, revision: draft.revision }], `hand-in-${question.id}`);
  return { input, receipt: runtime.confirmQuestionDelivery(student, activity.activityId, input) };
}

test("重开｜同一操作重发取回原回执且重启后不变；换来源、改目标版本或冒用开卷都报操作冲突", t => {
  const path = scenarioDatabase(t);
  const before = open(t, path);
  before.publish(deliveryPublication(lesson));
  const source = startFor(before, lesson.id);
  const other = startFor(before, lesson.id, student, "another-start");
  const receipt = restart(before, source, "again");
  assert.deepEqual(restart(before, source, "again"), receipt);
  before.close();
  const after = open(t, path);
  assert.deepEqual(restart(after, source, "again"), receipt);
  assert.deepEqual(restart(after, source, "again", 1), receipt);
  assert.throws(() => restart(after, other, "again"), conflict("OPERATION_CONFLICT"));
  assert.throws(() => restart(after, source, "again", 2), conflict("OPERATION_CONFLICT"));
  assert.throws(() => startFor(after, lesson.id, student, "again"), conflict("OPERATION_CONFLICT"));
  assert.throws(() => restart(after, source, "start-restart-lesson"), conflict("OPERATION_CONFLICT"));
});

test("重开｜只能从一条轮次链的最新一轮重开，旧轮的新重开报过期且不留写入", t => {
  const runtime = published(t);
  const source = startFor(runtime, lesson.id);
  const second = restart(runtime, source, "second");
  assert.throws(() => restart(runtime, source, "stale"), conflict("RESTART_STALE"));
  const third = restart(runtime, second, "third");
  assert.equal(lineage(runtime.read(student, third.activityId)), second.activityId);
  assert.throws(() => restart(runtime, second, "stale-again"), conflict("RESTART_STALE"));
  const unused = startFor(runtime, lesson.id, student, "stale");
  assert.equal(lineage(runtime.read(student, unused.activityId)), undefined);
});

test("重开｜进行中的一轮转为已放弃：拒绝存草稿、交付和换版，原交付可重放、可回取并继续评估", t => {
  const runtime = published(t);
  const source = runtime.prepare(student, { protocolVersion: 1, operationId: "prepared", practiceId: lesson.id, practiceVersion: 1 });
  const delivered = handIn(runtime, source, first, "甲");
  const draft = saveDraft(runtime, source, second, "乙");
  const next = restart(runtime, source, "abandon");
  const abandoned = runtime.read(student, source.activityId);
  assert.equal(abandoned.status, "abandoned");
  assert.ok("questionDeliveries" in abandoned);
  assert.equal(abandoned.questionDeliveries.length, 1);
  assert.throws(() => saveDraft(runtime, source, second, "丙", { baseRevision: draft.revision }), conflict("ACTIVITY_ABANDONED"));
  const late = deliveryInput(source, "question", [{ question: second, revision: draft.revision }], "late");
  assert.throws(() => runtime.confirmQuestionDelivery(student, source.activityId, late), conflict("ACTIVITY_ABANDONED"));
  assert.throws(() => runtime.replacePreparedActivityVersion(student, source.activityId, {
    protocolVersion: 1, operationId: "switch", stepAttemptId: source.stepAttemptId, expectedPracticeVersion: 1, practiceVersion: 1,
  }), conflict("ACTIVITY_ABANDONED"));
  assert.deepEqual(runtime.confirmQuestionDelivery(student, source.activityId, delivered.input), delivered.receipt);
  assert.deepEqual(runtime.evaluatePending(), { evaluated: 1, deferred: 0, retrying: 0, failed: 0 });
  const { evaluation } = runtime.recoverQuestionDelivery(student, source.activityId, recoveryKey(delivered.input));
  assert.ok(evaluation.status === "evaluated");
  assert.deepEqual(evaluation.questions.map(({ result }) => result), [{ status: "judged", correct: true }]);
  assert.equal(runtime.read(student, source.activityId).status, "abandoned");
  const fresh = runtime.read(student, next.activityId);
  assert.equal(fresh.status, "active");
  assert.ok("practiceVersion" in fresh);
  assert.equal(fresh.practiceVersion, 1);
});

test("重开｜已完成的来源保持已完成，回执和判分不变；新活动记录来源并开在冻结的同一版本", t => {
  const runtime = published(t);
  const source = startFor(runtime, lesson.id);
  const handed = [handIn(runtime, source, first, "甲"), handIn(runtime, source, second, "错")];
  runtime.evaluatePending();
  const recoverAll = () => handed.map(({ input }) => runtime.recoverQuestionDelivery(student, source.activityId, recoveryKey(input)));
  const before = recoverAll();
  const view = runtime.read(student, source.activityId);
  runtime.publish(deliveryPublication(shorter));
  const next = restart(runtime, source, "after-completion");
  assert.deepEqual(recoverAll(), before);
  assert.deepEqual(runtime.read(student, source.activityId), view);
  const fresh = runtime.read(student, next.activityId);
  assert.equal(lineage(fresh), source.activityId);
  assert.ok("inputs" in fresh);
  assert.deepEqual(JSON.stringify(fresh.inputs).match(/"id":"q\d"/g), ['"id":"q1"', '"id":"q2"']);
});

test("重开｜可显式开到同一练法的另一已发布版本，目标版本须存在且声明学生重开", t => {
  const runtime = published(t);
  const source = startFor(runtime, lesson.id);
  runtime.publish(deliveryPublication(shorter));
  runtime.publish(deliveryPublication({ ...lesson, version: 3, policy: contractPolicy }));
  assert.throws(() => restart(runtime, source, "missing", 4), { status: 404, code: "PRACTICE_NOT_FOUND" });
  assert.throws(() => restart(runtime, source, "fixed", 3), conflict("RESTART_NOT_AVAILABLE"));
  const next = restart(runtime, source, "upgrade", 2);
  const fresh = runtime.read(student, next.activityId);
  assert.ok("inputs" in fresh);
  assert.deepEqual(JSON.stringify(fresh.inputs).match(/"id":"q\d"/g), ['"id":"q1"']);
  assert.throws(() => restart(runtime, next, "from-fixed-target", 3), conflict("RESTART_NOT_AVAILABLE"));
});

test("重开｜他人不能重开本人的轮次，也读不到新一轮", t => {
  const runtime = published(t);
  const source = startFor(runtime, lesson.id);
  assert.throws(() => restart(runtime, source, "intrude", undefined, outsider), { status: 403, code: "FORBIDDEN" });
  const next = restart(runtime, source, "own");
  assert.throws(() => restart(runtime, source, "own", undefined, outsider), { status: 403, code: "FORBIDDEN" });
  assert.throws(() => runtime.read(outsider, next.activityId), { status: 403, code: "FORBIDDEN" });
  assert.equal(runtime.read(student, source.activityId).status, "abandoned");
});

test("重开｜未声明学生重开的练法拒绝重开且不改来源状态；非题组练法声明重开在发布时拒绝", t => {
  const runtime = published(t, { ...lesson, policy: contractPolicy });
  const source = startFor(runtime, lesson.id);
  assert.throws(() => restart(runtime, source, "denied"), conflict("RESTART_NOT_AVAILABLE"));
  assert.equal(runtime.read(student, source.activityId).status, "active");
  assert.equal(saveDraft(runtime, source, first, "甲").revision, 1);
  const passageReading = readingPublicationSchema.parse(reading);
  const { practice } = passageReading;
  const passage = { ...passageReading, practice: { ...practice, id: "restart-passage", policy: { ...practice.policy,
    student: { ...practice.policy.student, restart: "anytime" as const } } } };
  assert.throws(() => runtime.publish(passage), /学生重开只支持题组交付/);
  runtime.publish({ ...passageReading, practice: { ...practice, id: "plain-passage" } });
  const passageActivity = startFor(runtime, "plain-passage");
  assert.throws(() => restart(runtime, passageActivity, "passage"), conflict("RESTART_NOT_AVAILABLE"));
});
