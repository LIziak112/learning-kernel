import { strict as assert } from "node:assert";
import {
  contractPolicy, deliveryInput, deliveryPublication, evaluatorRef, outsider, questionSlot, recoveryKey, saveDraft, startFor, student,
} from "../fixtures/contracts/delivery.ts";
import type { Activity, Runtime } from "../fixtures/contracts/delivery.ts";
import { scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const practiceId = "g46";
const forbidden = { status: 403, code: "FORBIDDEN" };
const declaration = {
  id: practiceId, questions: [first, second], mode: "perQuestion", allowUnanswered: true,
  grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] },
} as const;

function openLesson(runtime: Runtime, operationId = "open-lesson") {
  runtime.publish(deliveryPublication(declaration));
  return startFor(runtime, practiceId, student, operationId);
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
      title: "开课幂等；逐题交付即时判分，交完全部题活动完成；新开一轮得到新活动并独立判分",
      run(world: StubWorld) {
        const runtime = world.open();
        const activity = openLesson(runtime);
        assert.deepEqual(openLesson(runtime), activity);
        const [one] = completeLesson(runtime, activity);
        assert.deepEqual(results(runtime, activity, one.key), [{ status: "judged", correct: true }]);
        assert.equal(runtime.read(student, activity.activityId).status, "completed");
        const restart = openLesson(runtime, "restart");
        assert.notEqual(restart.activityId, activity.activityId);
        assert.deepEqual(openLesson(runtime, "restart"), restart);
        assert.equal(runtime.read(student, restart.activityId).status, "active");
        const [again] = completeLesson(runtime, restart, ["错", "乙"]);
        assert.deepEqual(results(runtime, restart, again.key), [{ status: "judged", correct: false }]);
      },
    },
    authorize: {
      title: "现状限制：题组交付不支持授权重做（声明 authorizeRedo 发布即拒、已完成活动重做被拒），重开只能新开一轮；他人不能读或代交新一轮，旧轮作答尝试不能交进新一轮",
      run(world) {
        const runtime = world.open();
        const redoPolicy: typeof contractPolicy = { ...contractPolicy, manager: { ...contractPolicy.manager, actions: ["authorizeRedo"] } };
        assert.throws(() => runtime.publish(deliveryPublication({ ...declaration, id: "g46-redo", policy: redoPolicy })), /原值确认的评阅只声明/);
        const activity = openLesson(runtime);
        const [one] = completeLesson(runtime, activity);
        assert.throws(() => runtime.redo(student, activity.activityId, { protocolVersion: 1, operationId: "restart" }),
          { status: 409, code: "REDO_NOT_AVAILABLE" });
        const restart = openLesson(runtime, "restart");
        assert.throws(() => runtime.read(outsider, restart.activityId), forbidden);
        assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, one.key), forbidden);
        const draft = saveDraft(runtime, restart, first, "甲");
        const input = deliveryInput(restart, "question", [{ question: first, revision: draft.revision }], "restart-first");
        assert.throws(() => runtime.confirmQuestionDelivery(outsider, restart.activityId, input), forbidden);
        assert.throws(() => runtime.confirmQuestionDelivery(student, restart.activityId, { ...input, stepAttemptId: activity.stepAttemptId }),
          forbidden);
        assert.equal(runtime.confirmQuestionDelivery(student, restart.activityId, input).slotId, questionSlot(first.id));
      },
    },
    failure: {
      title: "一题评估连续失败三次转失败终态，不挡后续题评估与本轮完成",
      run(world) {
        const runtime = world.open();
        const activity = openLesson(runtime);
        world.failuresLeft = 3;
        const one = handIn(runtime, activity, first, "甲");
        const scope = { submissionId: one.receipt.id };
        for (const expected of [{ retrying: 1, failed: 0 }, { retrying: 1, failed: 0 }, { retrying: 0, failed: 1 }]) {
          assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, deferred: 0, ...expected });
        }
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, one.key).evaluation,
          { status: "failed", evaluator: evaluatorRef });
        const two = handIn(runtime, activity, second, "乙");
        runtime.evaluatePending();
        assert.deepEqual(results(runtime, activity, two.key), [{ status: "judged", correct: true }]);
        assert.equal(runtime.read(student, activity.activityId).status, "completed");
      },
    },
    withdraw: {
      title: "新开一轮从空白开始，作答不改写上一轮的回执、判分与读面；上一轮回取键不能用于新一轮",
      run(world) {
        const runtime = world.open();
        const activity = openLesson(runtime);
        const originals = completeLesson(runtime, activity);
        const recoverAll = () => originals.map(({ key }) => runtime.recoverQuestionDelivery(student, activity.activityId, key));
        const before = recoverAll();
        const originalView = runtime.read(student, activity.activityId);
        const restart = openLesson(runtime, "restart");
        const fresh = runtime.read(student, restart.activityId);
        assert.ok("questionDeliveries" in fresh);
        assert.deepEqual(fresh.questionDeliveries, []);
        completeLesson(runtime, restart, ["错", "错"]);
        assert.deepEqual(recoverAll(), before);
        assert.deepEqual(runtime.read(student, activity.activityId), originalView);
        assert.throws(() => runtime.recoverQuestionDelivery(student, restart.activityId, originals[0].key), forbidden);
      },
    },
  },
});
