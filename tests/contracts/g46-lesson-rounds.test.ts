import { strict as assert } from "node:assert";
import {
  contractPolicy, deliveryInput, deliveryPublication, evaluatorRef, outsider, override, questionSlot, recoveryKey, reviewer, saveDraft, startFor,
  student,
} from "../fixtures/contracts/delivery.ts";
import type { Activity, Runtime } from "../fixtures/contracts/delivery.ts";
import { scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const practiceId = "g46";
const forbidden = { status: 403, code: "FORBIDDEN" };
const abandoned = { status: 409, code: "ACTIVITY_ABANDONED" };
const restartPolicy: typeof contractPolicy = { ...contractPolicy, student: { ...contractPolicy.student, restart: "anytime" } };
const declaration = {
  id: practiceId, questions: [first, second], mode: "perQuestion", allowUnanswered: true,
  grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] }, policy: restartPolicy,
} as const;

function openLesson(runtime: Runtime, operationId = "open-lesson") {
  runtime.publish(deliveryPublication(declaration));
  return startFor(runtime, practiceId, student, operationId);
}

function restart(runtime: Runtime, source: Activity, operationId = "restart") {
  return runtime.restart(student, source.activityId, { protocolVersion: 1, operationId });
}

function handIn(runtime: Runtime, activity: Activity, question: typeof first, value: string) {
  const draft = saveDraft(runtime, activity, question, value);
  const input = deliveryInput(activity, "question", [{ question, revision: draft.revision }], `lesson-${question.id}`);
  return { input, key: recoveryKey(input), receipt: runtime.confirmQuestionDelivery(student, activity.activityId, input) };
}

function completeLesson(runtime: Runtime, activity: Activity, values: readonly [string, string] = ["甲", "错"]) {
  const handed = [handIn(runtime, activity, first, values[0]), handIn(runtime, activity, second, values[1])] as const;
  runtime.evaluatePending();
  return handed;
}

function results(runtime: Runtime, activity: Activity, key: ReturnType<typeof recoveryKey>) {
  const { evaluation } = runtime.recoverQuestionDelivery(student, activity.activityId, key);
  assert.ok(evaluation.status === "evaluated");
  return evaluation.questions.map(({ result }) => result);
}

scenarioContract({
  group: "G46",
  items: {
    submit: {
      title: "开课幂等；交完一轮后学生重开得到关联来源的新活动，重发取回同一回执，新一轮独立判分，旧轮仍是已完成",
      run(world: StubWorld) {
        const runtime = world.open();
        const activity = openLesson(runtime);
        assert.deepEqual(openLesson(runtime), activity);
        const [one] = completeLesson(runtime, activity);
        assert.deepEqual(results(runtime, activity, one.key), [{ status: "judged", correct: true }]);
        assert.equal(runtime.read(student, activity.activityId).status, "completed");
        const next = restart(runtime, activity);
        assert.notEqual(next.activityId, activity.activityId);
        assert.deepEqual(restart(runtime, activity), next);
        const fresh = runtime.read(student, next.activityId);
        assert.equal(fresh.status, "active");
        assert.ok("redoOf" in fresh);
        assert.equal(fresh.redoOf, activity.activityId);
        const [again] = completeLesson(runtime, next, ["错", "乙"]);
        assert.deepEqual(results(runtime, next, again.key), [{ status: "judged", correct: false }]);
        assert.equal(runtime.read(student, activity.activityId).status, "completed");
      },
    },
    authorize: {
      title: "未声明学生重开的题组拒绝重开；他人不能重开、读取或代交新一轮；旧轮步骤凭据不能交进新一轮；授权重做仍不可声明",
      run(world) {
        const runtime = world.open();
        const redoPolicy: typeof contractPolicy = { ...contractPolicy, manager: { ...contractPolicy.manager, actions: ["authorizeRedo"] } };
        assert.throws(() => runtime.publish(deliveryPublication({ ...declaration, id: "g46-redo", policy: redoPolicy })), /原值确认的评阅只声明/);
        runtime.publish(deliveryPublication({ ...declaration, id: "g46-fixed", policy: contractPolicy }));
        const fixed = startFor(runtime, "g46-fixed", student);
        assert.throws(() => restart(runtime, fixed), { status: 409, code: "RESTART_NOT_AVAILABLE" });
        const activity = openLesson(runtime);
        const [one] = completeLesson(runtime, activity);
        assert.throws(() => runtime.restart(outsider, activity.activityId, { protocolVersion: 1, operationId: "restart" }), forbidden);
        const next = restart(runtime, activity);
        assert.throws(() => runtime.read(outsider, next.activityId), forbidden);
        assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, one.key), forbidden);
        const draft = saveDraft(runtime, next, first, "甲");
        const input = deliveryInput(next, "question", [{ question: first, revision: draft.revision }], "restart-first");
        assert.throws(() => runtime.confirmQuestionDelivery(outsider, next.activityId, input), forbidden);
        assert.throws(() => runtime.confirmQuestionDelivery(student, next.activityId, { ...input, stepAttemptId: activity.stepAttemptId }),
          forbidden);
        assert.equal(runtime.confirmQuestionDelivery(student, next.activityId, input).slotId, questionSlot(first.id));
      },
    },
    failure: {
      title: "一题评估连续失败三次转失败终态；中途重开后放弃的一轮保留失败终态，新一轮照常评估并完成",
      run(world) {
        const runtime = world.open();
        const activity = openLesson(runtime);
        world.failuresLeft = 3;
        const one = handIn(runtime, activity, first, "甲");
        const scope = { submissionId: one.receipt.id };
        for (const expected of [{ retrying: 1, failed: 0 }, { retrying: 1, failed: 0 }, { retrying: 0, failed: 1 }]) {
          assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, deferred: 0, ...expected });
        }
        const failed = { status: "failed", evaluator: evaluatorRef };
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, one.key).evaluation, failed);
        const next = restart(runtime, activity);
        assert.equal(runtime.read(student, activity.activityId).status, "abandoned");
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, one.key).evaluation, failed);
        const [again] = completeLesson(runtime, next, ["甲", "乙"]);
        assert.deepEqual(results(runtime, next, again.key), [{ status: "judged", correct: true }]);
        assert.equal(runtime.read(student, next.activityId).status, "completed");
      },
    },
    withdraw: {
      title: "重开放弃进行中的一轮：旧轮拒绝再存草稿和交付，已确认回执与判分不变且仍可被教师改判；新一轮从空白开始，旧回取键不能用于新一轮",
      run(world) {
        const runtime = world.open();
        const activity = openLesson(runtime);
        const one = handIn(runtime, activity, first, "甲");
        runtime.evaluatePending();
        const before = runtime.recoverQuestionDelivery(student, activity.activityId, one.key);
        const draft = saveDraft(runtime, activity, second, "乙");
        const next = restart(runtime, activity);
        assert.equal(runtime.read(student, activity.activityId).status, "abandoned");
        assert.throws(() => saveDraft(runtime, activity, second, "丙", { baseRevision: draft.revision }), abandoned);
        const late = deliveryInput(activity, "question", [{ question: second, revision: draft.revision }], "late-second");
        assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, late), abandoned);
        assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, one.input), one.receipt);
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, one.key), before);
        const verdict = { receipt: one.receipt, questionId: first.id, operationId: "teacher-override", expectedRevision: 0 };
        const review = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, one.key, override(verdict, false));
        assert.equal(review.revision, 1);
        const fresh = runtime.read(student, next.activityId);
        assert.ok("questionDeliveries" in fresh);
        assert.deepEqual(fresh.questionDeliveries, []);
        assert.deepEqual(fresh.questionDeliveryDrafts, []);
        assert.throws(() => runtime.recoverQuestionDelivery(student, next.activityId, one.key), forbidden);
      },
    },
  },
});
