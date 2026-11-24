import { strict as assert } from "node:assert";
import { QuestionDeliveryConflict } from "../../src/server.ts";
import {
  deliveryInput, deliveryPublication, outsider, reviewer, saveDraft, slotId, startFor, student,
} from "../fixtures/contracts/delivery.ts";
import type { Activity, ContractQuestion, Runtime } from "../fixtures/contracts/delivery.ts";
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

function teacherScope(activity: Activity, question: ContractQuestion, questionVersion = question.version) {
  return { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion } as const;
}

function amend(runtime: Runtime, activity: Activity, question: ContractQuestion, value: string, baseRevision: number, operationId = "amend") {
  return runtime.amendQuestionDeliveryDraft(reviewer, activity.activityId,
    { ...teacherScope(activity, question), operationId, baseRevision, value, reason: "教师修正" });
}

function conflict(code: string, revision?: number) {
  return (error: unknown) => error instanceof QuestionDeliveryConflict && error.code === code
    && (revision === undefined || error.current.revision === revision);
}

scenarioContract({
  group: "G33",
  items: {
    submit: {
      title: "草稿按修订递增、同操作重发取回原修订；冲突、陈旧修订、非法值与陈旧题版本都拒绝，跨开库读回最新草稿，草稿跑评估队列也不评估，交付后学生与教师都不可再改",
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
        assert.throws(() => amend(reopened, activity, first, "交后改", 2), { status: 409, code: "ALREADY_SUBMITTED" });
      },
    },
    authorize: {
      title: "他人不能写入或读取本人草稿；本人读面只见自己的草稿，不泄露私有键；教师修正草稿与题面须经授权，结果只作草稿与新题面、不交付不评估",
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
        world.reviewAllowed = false;
        assert.throws(() => amend(runtime, activity, first, "越权", 1), { status: 403, code: "FORBIDDEN" });
        assert.throws(() => runtime.reviseQuestionDeliverySnapshot(reviewer, activity.activityId, {
          ...teacherScope(activity, second), operationId: "revise", baseRevision: 0, reason: "越权", question: { prompt: "改。" },
          key: stubKeyFor("丙"),
        }), { status: 403, code: "FORBIDDEN" });
        world.reviewAllowed = true;
        const amended = amend(runtime, activity, first, "乙", 1);
        assert.deepEqual([amended.revision, amended.changeCount], [2, 1]);
        assert.deepEqual(amend(runtime, activity, first, "乙", 1), amended);
        const revised = runtime.reviseQuestionDeliverySnapshot(reviewer, activity.activityId, {
          ...teacherScope(activity, second), operationId: "revise", baseRevision: 0, reason: "题面勘误", question: { prompt: "改后的题。" },
          key: stubKeyFor("丙"),
        });
        assert.equal(revised.questionVersion, second.version + 1);
        const after = runtime.read(student, activity.activityId);
        assert.ok("questionDeliveryDrafts" in after && "questionDeliveries" in after);
        assert.deepEqual(after.questionDeliveryDrafts, [amended]);
        assert.deepEqual(after.questionDeliveries, []);
        assert.match(JSON.stringify(after), /改后的题。/);
        assert.doesNotMatch(JSON.stringify(after), /丙|acceptedToken/);
        assert.deepEqual(runtime.evaluatePending(), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
        assert.deepEqual(world.evaluated, []);
      },
    },
    failure: { notApplicable: "草稿不评估" },
    withdraw: { notApplicable: "草稿按修订覆盖，无撤销语义" },
  },
});
