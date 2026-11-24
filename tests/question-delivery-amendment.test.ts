import { strict as assert } from "node:assert";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { ChoiceSnapshotRevisionConflict, QuestionDeliveryConflict } from "../src/server.ts";
import type {
  EvaluatorRegistration, QuestionDeliveryDraftInput, QuestionDeliverySnapshotRevisionInput, ReviewerPrincipal,
} from "../src/server.ts";
import {
  deliveryInput, deliveryPublication, evaluatorRef, openRuntime, recoveryKey, reviewer, saveDraft, slotId, startFor, student,
} from "./fixtures/contracts/delivery.ts";
import type { Activity, ContractQuestion, DeliveryDeclaration, Runtime } from "./fixtures/contracts/delivery.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const pick: ContractQuestion = { id: "pick", version: 1, prompt: "选一个。", response: "choice", options: { a: "甲", b: "乙" } };
const essay: ContractQuestion = { id: "essay", version: 1, prompt: "写一段。", response: "textWithOptionalTitle" };
const fill: ContractQuestion = { id: "fill", version: 1, prompt: "填两空。", response: "orderedTextBlanks", blankCount: 2 };
const lesson: DeliveryDeclaration = {
  id: "amend", questions: [pick, essay, fill], mode: "perQuestion", allowUnanswered: true,
  grading: { keys: { pick: { acceptedChoice: "a" }, fill: { acceptedBlanks: [["一"], ["二"]] } }, teacherReview: ["essay"] },
};
const values = new Map<string, readonly [Json, Json, Json]>([
  [pick.id, ["b", "a", "z"]],
  [essay.id, [{ body: "学生稿" }, { body: "教师修正", title: "题" }, { title: "缺正文" }]],
  [fill.id, [["错", "二"], ["一", "二"], "不是数组"]],
]);
const grader: EvaluatorRegistration = {
  ...evaluatorRef, responseTypes: ["choice", "orderedTextBlanks"],
  evaluate: ({ value, key }) => ({ status: "judged", correct: isDeepStrictEqual(
    Array.isArray(value) ? value.map(item => [item]) : value, Reflect.get(Object(key), Array.isArray(value) ? "acceptedBlanks" : "acceptedChoice")) }),
};

type Json = QuestionDeliveryDraftInput["value"];
type Hooks = { allow: boolean; evidence: boolean; actions: string[] };

function open(t: TestContext, hooks: Hooks = { allow: true, evidence: false, actions: [] }) {
  const runtime = openRuntime(scenarioDatabase(t), {
    evaluators: [grader],
    authorizeChoiceDraftAmendment: scope => { hooks.actions.push(scope.action); return hooks.allow; },
    authorizeChoiceSnapshotRevision: () => hooks.allow,
    hasChoiceSnapshotEvidence: () => hooks.evidence,
  });
  t.after(() => runtime.close());
  runtime.publish(deliveryPublication(lesson));
  return { runtime, activity: startFor(runtime, lesson.id), hooks };
}

function scope(activity: Activity, question: ContractQuestion, questionVersion = question.version) {
  return { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion } as const;
}

function amend(
  runtime: Runtime, activity: Activity, question: ContractQuestion, value: unknown, baseRevision: number,
  operationId = `amend-${question.id}`, principal: ReviewerPrincipal = reviewer,
) {
  return runtime.amendQuestionDeliveryDraft(principal, activity.activityId,
    { ...scope(activity, question), operationId, baseRevision, value, reason: "教师修正笔误" });
}

function revise(runtime: Runtime, activity: Activity, question: ContractQuestion, content: Pick<QuestionDeliverySnapshotRevisionInput, "question" | "key">,
  baseRevision = 0, operationId = `revise-${question.id}`) {
  return runtime.reviseQuestionDeliverySnapshot(reviewer, activity.activityId,
    { ...scope(activity, question), operationId, baseRevision, reason: "题面勘误", ...content });
}

const conflict = (code: string, revision?: number) => (error: unknown) => error instanceof QuestionDeliveryConflict
  && error.code === code && (revision === undefined || error.current.revision === revision);

function drafts(runtime: Runtime, activity: Activity) {
  const view = runtime.read(student, activity.activityId);
  assert.ok("questionDeliveryDrafts" in view);
  return { view, drafts: view.questionDeliveryDrafts };
}

for (const question of [pick, essay, fill]) {
  const [studentValue = null, teacherValue = null, invalid = null] = values.get(question.id) ?? [];
  test(`教师修正题组草稿｜${question.response}：按修订竞争、原因留痕、重发取回，学生见新草稿且不计改答、不交付不评估`, t => {
    const { runtime, activity, hooks } = open(t);
    saveDraft(runtime, activity, question, studentValue);
    assert.throws(() => amend(runtime, activity, question, teacherValue, 0), conflict("ANSWER_REVISION_CONFLICT", 1));
    assert.throws(() => amend(runtime, activity, question, invalid, 1), { status: 422 });
    const amended = amend(runtime, activity, question, teacherValue, 1);
    assert.deepEqual(amended, { slotId, questionId: question.id, questionVersion: 1, value: teacherValue, revision: 2, changeCount: 1 });
    assert.deepEqual(amend(runtime, activity, question, teacherValue, 1), amended);
    assert.throws(() => amend(runtime, activity, question, studentValue, 1), { status: 409, code: "OPERATION_CONFLICT" });
    assert.throws(() => runtime.amendQuestionDeliveryDraft(reviewer, activity.activityId,
      { ...scope(activity, question), operationId: "blank", baseRevision: 2, value: teacherValue, reason: " " }));
    const read = runtime.readQuestionDeliveryDraftForAmendment(reviewer, activity.activityId, scope(activity, question));
    assert.equal(read.revision, 2);
    assert.deepEqual(read.value, teacherValue);
    assert.deepEqual(read.history.amendments.map(({ revision, reviewerId, reason }) => ({ revision, reviewerId, reason })),
      [{ revision: 2, reviewerId: reviewer.id, reason: "教师修正笔误" }]);
    assert.deepEqual(read.history.snapshots, []);
    const { view, drafts: current } = drafts(runtime, activity);
    assert.deepEqual(current, [amended]);
    assert.ok("questionDeliveries" in view);
    assert.deepEqual(view.questionDeliveries, []);
    assert.equal(view.status, "active");
    assert.deepEqual(runtime.evaluatePending(), { evaluated: 0, deferred: 0, retrying: 0, failed: 0 });
    const next = saveDraft(runtime, activity, question, studentValue, { baseRevision: 2, operationId: "student-after" });
    assert.deepEqual([next.revision, next.changeCount], [3, 2]);
    assert.deepEqual(hooks.actions, ["amend", "amend", "amend", "amend", "amend", "read"]);
  });
}

test("教师修正题组草稿｜学生未作答也可写入首稿，不计改答；已交付、拒绝授权或冒用学生身份都拒绝", t => {
  const { runtime, activity, hooks } = open(t);
  assert.deepEqual(runtime.readQuestionDeliveryDraftForAmendment(reviewer, activity.activityId, scope(activity, fill)),
    { slotId, questionId: fill.id, questionVersion: 1, value: null, revision: 0, changeCount: 0, history: { amendments: [], snapshots: [] } });
  const first = amend(runtime, activity, fill, ["一", "二"], 0);
  assert.deepEqual([first.revision, first.changeCount], [1, 0]);
  runtime.confirmQuestionDelivery(student, activity.activityId, deliveryInput(activity, "question", [{ question: fill, revision: 1 }], "deliver"));
  assert.throws(() => amend(runtime, activity, fill, ["一", "三"], 1, "late"), { status: 409, code: "ALREADY_SUBMITTED" });
  assert.deepEqual(amend(runtime, activity, fill, ["一", "二"], 0), first);
  assert.throws(() => amend(runtime, activity, pick, "a", 0, "student", { role: "student", id: student.id } as never), { status: 403 });
  hooks.allow = false;
  assert.throws(() => amend(runtime, activity, pick, "a", 0), { status: 403, code: "FORBIDDEN" });
  assert.throws(() => runtime.readQuestionDeliveryDraftForAmendment(reviewer, activity.activityId, scope(activity, pick)),
    { status: 403, code: "FORBIDDEN" });
  assert.deepEqual(drafts(runtime, activity).drafts, []);
});

test("题面勘误｜三种形态在作答前改题面、配置与评分键，学生按新版本作答，评估采用勘误后的键", t => {
  const { runtime, activity } = open(t);
  const choice = revise(runtime, activity, pick, { question: { prompt: "改为三选一。", options: { a: "甲", b: "乙", c: "丙" } },
    key: { acceptedChoice: "c" } });
  assert.deepEqual(choice, { slotId, questionId: pick.id, questionVersion: 2, revision: 1, previousQuestionVersion: 1 });
  assert.deepEqual(revise(runtime, activity, pick, { question: { prompt: "改为三选一。", options: { a: "甲", b: "乙", c: "丙" } },
    key: { acceptedChoice: "c" } }), choice);
  assert.throws(() => revise(runtime, activity, pick, { question: { prompt: "另一版。", options: { a: "甲" } }, key: { acceptedChoice: "a" } }),
    { status: 409, code: "OPERATION_CONFLICT" });
  revise(runtime, activity, essay, { question: { prompt: "改写一段。" } });
  revise(runtime, activity, fill, { question: { prompt: "只填一空。", blankCount: 1 }, key: { acceptedBlanks: [["一"]] } });
  const { view } = drafts(runtime, activity);
  assert.ok("choiceSnapshotRevisions" in view && "inputs" in view);
  assert.deepEqual(view.choiceSnapshotRevisions.map(({ questionId, questionVersion, revision }) => [questionId, questionVersion, revision]),
    [["essay", 2, 1], ["fill", 2, 1], ["pick", 2, 1]]);
  assert.match(JSON.stringify(view.inputs), /改为三选一。.*改写一段。.*只填一空。/);
  assert.doesNotMatch(JSON.stringify(view), /acceptedChoice|acceptedBlanks/);
  assert.throws(() => saveDraft(runtime, activity, pick, "c"), { status: 409, code: "QUESTION_REVISION_STALE" });
  const revisedPick = { ...pick, version: 2 };
  const revisedFill = { ...fill, version: 2 };
  assert.throws(() => saveDraft(runtime, activity, revisedPick, "c"), conflict("ANSWER_REVISION_CONFLICT", 1));
  const handed: [ContractQuestion, Json][] = [[revisedPick, "c"], [revisedFill, ["一"]]];
  const keys = handed.map(([question, value]) => {
    const draft = saveDraft(runtime, activity, question, value, { baseRevision: 1 });
    assert.equal(draft.revision, 2);
    const input = deliveryInput(activity, "question", [{ question, revision: 2 }], `deliver-${question.id}`);
    runtime.confirmQuestionDelivery(student, activity.activityId, input);
    return recoveryKey(input);
  });
  runtime.evaluatePending();
  for (const key of keys) {
    const { evaluation } = runtime.recoverQuestionDelivery(student, activity.activityId, key);
    assert.ok(evaluation.status === "evaluated");
    assert.deepEqual(evaluation.questions.map(({ result }) => result), [{ status: "judged", correct: true }]);
  }
});

test("题面勘误｜已有草稿或作答证据、陈旧修订、改形态、配置不合法、评分键不符都拒绝且不留写入", t => {
  const { runtime, activity, hooks } = open(t);
  saveDraft(runtime, activity, essay, { body: "已作答" });
  assert.throws(() => revise(runtime, activity, essay, { question: { prompt: "迟到勘误。" } }, 1), { status: 409, code: "RESPONSE_EVIDENCE_EXISTS" });
  assert.throws(() => revise(runtime, activity, fill, { question: { prompt: "改。", blankCount: 2 }, key: { acceptedBlanks: [["一"], ["二"]] } }, 3),
    (error: unknown) => error instanceof ChoiceSnapshotRevisionConflict && error.current.revision === 0);
  const invalid: [ContractQuestion, Pick<QuestionDeliverySnapshotRevisionInput, "question" | "key">, string][] = [
    [fill, { question: { prompt: "缺空位数。" }, key: { acceptedBlanks: [["一"]] } }, "INVALID_QUESTION"],
    [pick, { question: { prompt: "没有选项。" }, key: { acceptedChoice: "a" } }, "INVALID_QUESTION"],
    [fill, { question: { prompt: "空位与键不符。", blankCount: 3 }, key: { acceptedBlanks: [["一"]] } }, "INVALID_KEY"],
    [pick, { question: { prompt: "缺键。", options: { a: "甲" } } }, "INVALID_KEY"],
    [essay, { question: { prompt: "教师评阅题不带键。" }, key: {} }, "INVALID_KEY"],
  ];
  const fresh = open(t);
  for (const [question, content, code] of invalid) {
    assert.throws(() => revise(fresh.runtime, fresh.activity, question, content), { status: 422, code });
  }
  assert.throws(() => revise(fresh.runtime, fresh.activity, pick, { question: { prompt: "改形态。", response: "textWithOptionalTitle" } }));
  fresh.hooks.evidence = true;
  assert.throws(() => revise(fresh.runtime, fresh.activity, essay, { question: { prompt: "宿主证据。" } }),
    { status: 409, code: "RESPONSE_EVIDENCE_EXISTS" });
  hooks.allow = false;
  assert.throws(() => revise(runtime, activity, pick, { question: { prompt: "无权。", options: { a: "甲" } }, key: { acceptedChoice: "a" } }),
    { status: 403, code: "FORBIDDEN" });
  const view = fresh.runtime.read(student, fresh.activity.activityId);
  assert.equal("choiceSnapshotRevisions" in view, false);
});
