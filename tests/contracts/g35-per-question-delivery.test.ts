import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import {
  deliveryInput, deliveryPublication, outsider, override, questionSlot, recoveryKey, reviewer, saveDraft, startFor, student, withdraw,
} from "../fixtures/contracts/delivery.ts";
import type { Activity, Runtime } from "../fixtures/contracts/delivery.ts";
import { pendingToken, scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1", 2);
const second = stubQuestion("q2", 3);
const third = stubQuestion("q3", 4);
const practiceId = "g35";
const publication = deliveryPublication({
  id: practiceId, questions: [first, second, third], mode: "perQuestion", allowUnanswered: true,
  grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙"), q3: stubKeyFor("丙") }, teacherReview: [] },
});

function begin(world: StubWorld) {
  const runtime = world.open();
  runtime.publish(publication);
  return { runtime, activity: startFor(runtime, practiceId) };
}

function handInOne(runtime: Runtime, activity: Activity, question: typeof first, value: string, operationId = `hand-in-${question.id}`) {
  const saved = saveDraft(runtime, activity, question, value);
  const input = deliveryInput(activity, "question", [{ question, revision: saved.revision }], operationId);
  return { input, key: recoveryKey(input), receipt: runtime.confirmQuestionDelivery(student, activity.activityId, input) };
}

function verdicts(runtime: Runtime, activity: Activity, key: ReturnType<typeof recoveryKey>) {
  return runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts").questions;
}

function settled(runtime: Runtime, activity: Activity, key: ReturnType<typeof recoveryKey>) {
  return verdicts(runtime, activity, key).map(question =>
    ({ revision: question.revision, status: question.status, effective: "effective" in question ? question.effective : undefined }));
}

function tableCount(databasePath: string, table: string) {
  using database = new DatabaseSync(databasePath, { readOnly: true });
  return database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
}

scenarioContract({
  group: "G35",
  items: {
    submit: {
      title: "逐题提交占独立位置、重发取回原回执；分段结算只收余题并完成活动，跨开库读回不变",
      run(world) {
        const { runtime, activity } = begin(world);
        const one = handInOne(runtime, activity, first, "甲");
        assert.equal(one.receipt.slotId, questionSlot(first.id));
        assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, one.input), one.receipt);
        assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, { ...one.input, operationId: "competing" }),
          { status: 409, code: "ALREADY_SUBMITTED" });
        assert.throws(() => saveDraft(runtime, activity, first, "改", { baseRevision: 1 }), { status: 409, code: "ALREADY_SUBMITTED" });
        assert.equal(runtime.read(student, activity.activityId).status, "active");
        runtime.evaluatePending();
        const read = runtime.recoverQuestionDelivery(student, activity.activityId, one.key);
        assert.equal(read.confirmation.source, "question");
        assert.ok(read.evaluation.status === "evaluated");
        assert.deepEqual(read.evaluation.questions.map(({ questionId, result }) => ({ questionId, result })),
          [{ questionId: first.id, result: { status: "judged", correct: true } }]);

        const later = saveDraft(runtime, activity, second, "错");
        const settle = deliveryInput(activity, "finish",
          [{ question: first, revision: 0 }, { question: second, revision: later.revision }, { question: third, revision: 0 }], "settle");
        const settled = runtime.confirmQuestionDelivery(student, activity.activityId, settle);
        assert.equal(settled.slotId, "work");
        assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, settle), settled);
        assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, { ...settle, operationId: "settle-again" }),
          { status: 409, code: "ALREADY_SUBMITTED" });
        runtime.evaluatePending();
        const settlement = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(settle));
        assert.equal(settlement.confirmation.source, "finish");
        assert.deepEqual(settlement.confirmation.questions.map(({ questionId, value }) => ({ questionId, value })),
          [{ questionId: second.id, value: "错" }, { questionId: third.id, value: null }]);
        assert.ok(settlement.evaluation.status === "evaluated");
        assert.deepEqual([settlement.evaluation.correctCount, settlement.evaluation.questionCount], [0, 2]);
        assert.equal(runtime.read(student, activity.activityId).status, "completed");
        assert.deepEqual(world.evaluated, [first.id, second.id, third.id]);
        const before = runtime.read(student, activity.activityId);
        runtime.close();

        const reopened = world.open();
        assert.deepEqual(reopened.read(student, activity.activityId), before);
        assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, recoveryKey(settle)), settlement);
        assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, one.key), read);
        assert.equal(reopened.evaluatePending().evaluated, 0);
        assert.deepEqual([tableCount(world.databasePath, "submissions"), tableCount(world.databasePath, "completions")], [2, 1]);
      },
    },
    authorize: {
      title: "他人不能代交或回取，撤权后本人回取与重交都拒绝；评阅只认获准评阅人，学生读面不泄露私有键",
      run(world) {
        const { runtime, activity } = begin(world);
        const one = handInOne(runtime, activity, first, "甲");
        const forbidden = { status: 403, code: "FORBIDDEN" };
        assert.throws(() => runtime.confirmQuestionDelivery(outsider, activity.activityId, one.input), forbidden);
        assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, one.key), forbidden);
        assert.throws(() => saveDraft(runtime, activity, second, "乙", { principal: outsider }), forbidden);
        runtime.evaluatePending();
        assert.equal(verdicts(runtime, activity, one.key).length, 1);
        assert.doesNotMatch(JSON.stringify([runtime.read(student, activity.activityId),
          runtime.recoverQuestionDelivery(student, activity.activityId, one.key)]), /acceptedToken|acceptedByQuestion/);
        assert.throws(() => runtime.readQuestionDeliveryReview({ ...reviewer, id: "contract-other-reviewer" }, activity.activityId, one.key,
          "verdicts"), { code: "FORBIDDEN" });
        world.reviewAllowed = false;
        assert.throws(() => verdicts(runtime, activity, one.key), { code: "FORBIDDEN" });
        world.recoveryAllowed = false;
        assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, one.key), forbidden);
        assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, one.input), forbidden);
        assert.equal(tableCount(world.databasePath, "submissions"), 1);
      },
    },
    failure: {
      title: "评估器连续失败三次转失败终态，提交保留、学生只见失败、教师可人工判定；其余位置照常评估",
      run(world) {
        const { runtime, activity } = begin(world);
        world.failuresLeft = 3;
        const one = handInOne(runtime, activity, first, "甲");
        const scope = { submissionId: one.receipt.id };
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 1, deferred: 0 });
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
        const failed = runtime.recoverQuestionDelivery(student, activity.activityId, one.key);
        assert.deepEqual(failed.receipt, one.receipt);
        assert.deepEqual(failed.evaluation, { status: "failed", evaluator: { id: "contract-evaluator", version: 1 } });
        assert.doesNotMatch(JSON.stringify(runtime.read(student, activity.activityId)), /桩评估器故障|EVALUATOR_FAILED/);
        assert.deepEqual(verdicts(runtime, activity, one.key).map(({ status }) => status), ["evaluationFailed"]);
        const manual = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, one.key,
          override({ receipt: one.receipt, questionId: first.id, operationId: "manual", expectedRevision: 0 }, true));
        assert.deepEqual(settled(runtime, activity, one.key),
          [{ revision: 1, status: "judged", effective: { source: "teacherReview", id: manual.id, correct: true } }]);

        assert.equal(world.failuresLeft, 0);
        const two = handInOne(runtime, activity, second, "乙");
        assert.deepEqual(runtime.evaluatePending(), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
        const evaluated = runtime.recoverQuestionDelivery(student, activity.activityId, two.key);
        assert.ok(evaluated.evaluation.status === "evaluated");
        assert.equal(evaluated.evaluation.correctCount, 1);
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, one.key).evaluation, failed.evaluation);
        assert.deepEqual(world.evaluated, [first.id, first.id, first.id, second.id]);
      },
    },
    withdraw: {
      title: "逐题回执上的教师改判可清除回落到自动原判；陈旧修订被拒，重发取回原回执，其他位置不受影响",
      run(world) {
        const { runtime, activity } = begin(world);
        const one = handInOne(runtime, activity, first, "甲");
        const two = handInOne(runtime, activity, second, "错");
        runtime.evaluatePending();
        const studentBefore = runtime.recoverQuestionDelivery(student, activity.activityId, one.key);
        const otherBefore = verdicts(runtime, activity, two.key);
        const location = { receipt: one.receipt, questionId: first.id };
        const write = (command: Parameters<Runtime["writeQuestionDeliveryVerdict"]>[3]) =>
          runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, one.key, command);
        const marked = write(override({ ...location, operationId: "mark", expectedRevision: 0 }, false));
        assert.deepEqual(settled(runtime, activity, one.key),
          [{ revision: 1, status: "judged", effective: { source: "teacherReview", id: marked.id, correct: false } }]);
        assert.throws(() => write(withdraw({ ...location, operationId: "stale", expectedRevision: 0 }, marked.id)), { code: "VERDICT_CONFLICT" });
        const cleared = write(withdraw({ ...location, operationId: "clear", expectedRevision: 1 }, marked.id));
        assert.deepEqual(write(withdraw({ ...location, operationId: "clear", expectedRevision: 1 }, marked.id)), cleared);
        assert.deepEqual(settled(runtime, activity, one.key),
          [{ revision: 2, status: "judged", effective: { source: "automatic", correct: true } }]);
        assert.deepEqual(verdicts(runtime, activity, two.key), otherBefore);
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, one.key), studentBefore);
        const elsewhere = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, two.key,
          override({ receipt: two.receipt, questionId: second.id, operationId: "mark-two", expectedRevision: 0 }, true));
        assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, two.key,
          withdraw({ receipt: two.receipt, questionId: second.id, operationId: "cross", expectedRevision: 1 }, marked.id)),
        { code: "VERDICT_CONFLICT" });
        assert.deepEqual(settled(runtime, activity, two.key),
          [{ revision: 1, status: "judged", effective: { source: "teacherReview", id: elsewhere.id, correct: true } }]);
        assert.deepEqual(settled(runtime, activity, one.key),
          [{ revision: 2, status: "judged", effective: { source: "automatic", correct: true } }]);

        const three = handInOne(runtime, activity, third, pendingToken);
        runtime.evaluatePending();
        assert.deepEqual(settled(runtime, activity, three.key), [{ revision: 0, status: "needsReview", effective: undefined }]);
        const pendingMark = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, three.key,
          override({ receipt: three.receipt, questionId: third.id, operationId: "mark-three", expectedRevision: 0 }, false));
        runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, three.key,
          withdraw({ receipt: three.receipt, questionId: third.id, operationId: "clear-three", expectedRevision: 1 }, pendingMark.id));
        assert.deepEqual(settled(runtime, activity, three.key), [{ revision: 2, status: "needsReview", effective: undefined }]);
      },
    },
  },
});
