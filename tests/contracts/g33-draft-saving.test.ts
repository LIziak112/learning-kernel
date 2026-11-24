import { strict as assert } from "node:assert";
import { QuestionDeliveryConflict } from "../../src/server.ts";
import { deliveryInput, deliveryPublication, outsider, saveDraft, slotId, startFor, student } from "../fixtures/contracts/delivery.ts";
import { scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const practiceId = "g33";
const publication = deliveryPublication({
  id: practiceId, questions: [first, second], mode: "whole", allowUnanswered: true,
  grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] },
});

function begin(world: StubWorld) {
  const runtime = world.open();
  runtime.publish(publication);
  return { runtime, activity: startFor(runtime, practiceId) };
}

function conflict(code: string, revision?: number) {
  return (error: unknown) => error instanceof QuestionDeliveryConflict && error.code === code
    && (revision === undefined || error.current.revision === revision);
}

scenarioContract({
  group: "G33",
  items: {
    submit: {
      title: "草稿按修订递增、同操作重发取回原修订；冲突、陈旧修订、非法值与陈旧题版本都拒绝，跨开库读回最新草稿，草稿跑评估队列也不评估，交付后不可再改",
      run(world) {
        const { runtime, activity } = begin(world);
        const draft = saveDraft(runtime, activity, first, "草稿一");
        assert.equal(draft.revision, 1);
        assert.deepEqual(saveDraft(runtime, activity, first, "草稿一"), draft);
        assert.throws(() => saveDraft(runtime, activity, first, "另一稿"), conflict("OPERATION_CONFLICT"));
        const revised = saveDraft(runtime, activity, first, "甲", { baseRevision: 1, operationId: "revise" });
        assert.equal(revised.revision, 2);
        assert.throws(() => saveDraft(runtime, activity, first, "迟到", { baseRevision: 1, operationId: "late-write" }),
          conflict("ANSWER_REVISION_CONFLICT", 2));
        const base = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: first.id, baseRevision: 2 } as const;
        assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId,
          { ...base, questionVersion: first.version, operationId: "malformed", value: 1 }), { status: 422, code: "INVALID_RESPONSE" });
        assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId,
          { ...base, questionVersion: first.version + 1, operationId: "stale-version", value: "甲" }), { status: 409, code: "QUESTION_REVISION_STALE" });
        runtime.close();

        const reopened = world.open();
        const view = reopened.read(student, activity.activityId);
        assert.ok("questionDeliveryDrafts" in view);
        assert.deepEqual(view.questionDeliveryDrafts, [revised]);
        assert.deepEqual(reopened.evaluatePending(), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
        assert.deepEqual(world.evaluated, []);
        reopened.confirmQuestionDelivery(student, activity.activityId,
          deliveryInput(activity, "whole", [{ question: first, revision: 2 }, { question: second, revision: 0 }], "whole"));
        assert.throws(() => saveDraft(reopened, activity, first, "交后", { baseRevision: 2, operationId: "after-confirm" }),
          { status: 409, code: "ALREADY_SUBMITTED" });
      },
    },
    authorize: {
      title: "他人不能写入或读取本人草稿；本人读面只见自己的草稿，不泄露私有键",
      run(world) {
        const { runtime, activity } = begin(world);
        const saved = saveDraft(runtime, activity, first, "甲");
        assert.equal(saved.revision, 1);
        assert.throws(() => saveDraft(runtime, activity, first, "闯入", { baseRevision: 1, operationId: "intrude", principal: outsider }),
          { status: 403, code: "FORBIDDEN" });
        assert.throws(() => runtime.read(outsider, activity.activityId), { status: 403, code: "FORBIDDEN" });
        const view = runtime.read(student, activity.activityId);
        assert.ok("questionDeliveryDrafts" in view);
        assert.deepEqual(view.questionDeliveryDrafts, [saved]);
        assert.doesNotMatch(JSON.stringify(view), /acceptedToken|acceptedByQuestion|contract-key/);
      },
    },
    failure: { notApplicable: "草稿不评估" },
    withdraw: { notApplicable: "草稿按修订覆盖，无撤销语义" },
  },
});
