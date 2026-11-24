import { strict as assert } from "node:assert";
import { deliveryInput, deliveryPublication, outsider, questionSlot, recoveryKey, saveDraft, slotId, student } from "../fixtures/contracts/delivery.ts";
import type { Activity, Runtime } from "../fixtures/contracts/delivery.ts";
import { scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const practiceId = "g32";
const forbidden = { status: 403, code: "FORBIDDEN" };

function publication(mode: "whole" | "perQuestion", version: number) {
  return deliveryPublication({
    id: practiceId, version, questions: [first, second], mode, allowUnanswered: true,
    grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] },
  });
}

function openSwitchable(world: StubWorld) {
  const runtime = world.open();
  runtime.publish(publication("whole", 1));
  runtime.publish(publication("perQuestion", 2));
  const request = { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: "open-g32" } as const;
  return { runtime, request, activity: runtime.prepare(student, request) };
}

function switchCommand(activity: Pick<Activity, "stepAttemptId">, expectedPracticeVersion: number, practiceVersion: number, operationId: string) {
  return { protocolVersion: 1, intent: "questionDeliveryMode", stepAttemptId: activity.stepAttemptId,
    expectedPracticeVersion, practiceVersion, operationId } as const;
}

type Switched = Activity & ReturnType<Runtime["replacePreparedActivityVersion"]>;
function switchTo(runtime: Runtime, activity: Activity, command: ReturnType<typeof switchCommand>): Switched {
  return { ...activity, ...runtime.replacePreparedActivityVersion(student, activity.activityId, command) };
}

scenarioContract({
  group: "G32",
  items: {
    submit: {
      title: "开卷幂等、正式开始取回同一活动；整卷切逐题保留草稿、重发与跨开库取回同一切换，逐题交付后不能再切",
      run(world) {
        const { runtime, request, activity } = openSwitchable(world);
        assert.deepEqual(runtime.prepare(student, request), activity);
        assert.deepEqual(runtime.start(student, request), activity);
        assert.throws(() => runtime.prepare(student, { ...request, practiceVersion: 2 }), { status: 409, code: "OPERATION_CONFLICT" });
        const draft = saveDraft(runtime, activity, first, "甲");
        const command = switchCommand(activity, 1, 2, "to-per-question");
        const switched = switchTo(runtime, activity, command);
        assert.equal(switched.activityId, activity.activityId);
        assert.equal(switched.practiceVersion, 2);
        assert.notEqual(switched.stepAttemptId, activity.stepAttemptId);
        assert.deepEqual(switchTo(runtime, activity, command), switched);
        runtime.close();

        const reopened = world.open();
        assert.deepEqual(switchTo(reopened, activity, command), switched);
        const moved = reopened.saveQuestionDeliveryDraft(student, activity.activityId, {
          protocolVersion: 1, stepAttemptId: switched.stepAttemptId, slotId, questionId: first.id, questionVersion: first.version,
          operationId: `save-${first.id}-0`, baseRevision: 0, value: "甲",
        }, "replayLatestOnly");
        assert.deepEqual(moved, draft);
        const input = deliveryInput(switched, "question", [{ question: first, revision: draft.revision }], "first-after-switch");
        const receipt = reopened.confirmQuestionDelivery(student, activity.activityId, input);
        assert.equal(receipt.slotId, questionSlot(first.id));
        reopened.evaluatePending();
        const recovered = reopened.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input));
        assert.ok(recovered.evaluation.status === "evaluated");
        assert.equal(recovered.evaluation.correctCount, 1);
        assert.throws(() => switchTo(reopened, activity, switchCommand(switched, 2, 1, "back-after-delivery")),
          { status: 409, code: "ACTIVITY_ALREADY_STARTED" });
      },
    },
    authorize: {
      title: "他人不能读、不能切换本人活动，开卷只得到自己的活动；切换后旧作答尝试的草稿写入被拒，陈旧切换冲突",
      run(world) {
        const { runtime, request, activity } = openSwitchable(world);
        assert.equal(runtime.read(student, activity.activityId).activityId, activity.activityId);
        assert.throws(() => runtime.read(outsider, activity.activityId), forbidden);
        saveDraft(runtime, activity, first, "甲");
        const command = switchCommand(activity, 1, 2, "to-per-question");
        assert.throws(() => runtime.replacePreparedActivityVersion(outsider, activity.activityId, command), forbidden);
        assert.notEqual(runtime.prepare(outsider, request).activityId, activity.activityId);
        const switched = switchTo(runtime, activity, command);
        assert.throws(() => saveDraft(runtime, activity, first, "甲"), forbidden);
        assert.equal(saveDraft(runtime, switched, first, "改", { baseRevision: 1, operationId: "revise-after-switch" }).revision, 2);
        assert.throws(() => runtime.replacePreparedActivityVersion(student, activity.activityId, { ...command, operationId: "stale-switch" }),
          { status: 409, code: "ACTIVITY_VERSION_CONFLICT" });
      },
    },
    failure: { notApplicable: "切换不触发评估" },
    withdraw: {
      title: "逐题切回整卷：版本与读面回到切换前，只换作答尝试；整卷交付占整卷位置，旧作答尝试交付被拒",
      run(world) {
        const { runtime, activity } = openSwitchable(world);
        saveDraft(runtime, activity, first, "甲");
        const before = runtime.read(student, activity.activityId);
        const forward = switchTo(runtime, activity, switchCommand(activity, 1, 2, "forward"));
        const back = switchTo(runtime, activity, switchCommand(forward, 2, 1, "back"));
        assert.equal(back.practiceVersion, 1);
        assert.notEqual(back.stepAttemptId, forward.stepAttemptId);
        assert.deepEqual(runtime.read(student, activity.activityId), { ...before, stepAttemptId: back.stepAttemptId });
        const whole = deliveryInput(back, "whole", [{ question: first, revision: 1 }, { question: second, revision: 0 }], "whole");
        assert.equal(runtime.confirmQuestionDelivery(student, activity.activityId, whole).slotId, slotId);
        assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId,
          { ...whole, stepAttemptId: forward.stepAttemptId, operationId: "stale" }), forbidden);
      },
    },
  },
});
