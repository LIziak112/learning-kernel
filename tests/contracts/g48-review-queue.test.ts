import { strict as assert } from "node:assert";
import { deliveryInput, deliveryPublication, override, recoveryKey, reviewer, saveDraft, startFor, student, withdraw } from "../fixtures/contracts/delivery.ts";
import type { ContractQuestion, DeliveryReceipt, Runtime } from "../fixtures/contracts/delivery.ts";
import { scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const practiceId = "g48";
const forbidden = { status: 403, code: "FORBIDDEN" };
const publication = deliveryPublication({
  id: practiceId, questions: [first, second], mode: "whole", allowUnanswered: true,
  grading: { keys: { q1: stubKeyFor("甲") }, teacherReview: [second.id] },
});

type Queue = Readonly<{ activityId: string; input: ReturnType<typeof deliveryInput>; key: ReturnType<typeof recoveryKey>; receipt: DeliveryReceipt }>;

function handInQueue(world: StubWorld, value = "甲") {
  const runtime = world.open();
  runtime.publish(publication);
  const activity = startFor(runtime, practiceId);
  const handed = [first, second].map(question => ({ question, revision: saveDraft(runtime, activity, question, value).revision }));
  const input = deliveryInput(activity, "whole", handed, "hand-in");
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  return { runtime, queue: { activityId: activity.activityId, input, key: recoveryKey(input), receipt } satisfies Queue };
}

function verdicts(runtime: Runtime, { activityId, key }: Queue) {
  return runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts").questions;
}

function slot(question: ContractQuestion, revision: number, status: string) {
  return { questionId: question.id, questionVersion: question.version, revision, status };
}

function automaticSlot(question: ContractQuestion, revision: number, correct: boolean) {
  return { ...slot(question, revision, "judged"), automatic: { correct, valid: true }, effective: { source: "automatic", correct } };
}

function teacherSlot(question: ContractQuestion, revision: number, id: string, correct: boolean) {
  return { ...slot(question, revision, "judged"), effective: { source: "teacherReview", id, correct } };
}

function mark(runtime: Runtime, queue: Queue, question: ContractQuestion, operationId: string, expectedRevision: number, correct: boolean) {
  return runtime.writeQuestionDeliveryVerdict(reviewer, queue.activityId, queue.key,
    override({ receipt: queue.receipt, questionId: question.id, operationId, expectedRevision }, correct));
}

function clear(runtime: Runtime, queue: Queue, question: ContractQuestion, operationId: string, expectedRevision: number, withdrawId: string) {
  return runtime.writeQuestionDeliveryVerdict(reviewer, queue.activityId, queue.key,
    withdraw({ receipt: queue.receipt, questionId: question.id, operationId, expectedRevision }, withdrawId));
}

scenarioContract({
  group: "G48",
  items: {
    submit: {
      title: "整卷交付后待批队列：自动题先待评估再判，主观题待教师判；教师判定幂等、同操作改值冲突，跨开库读回",
      run(world) {
        const { runtime, queue } = handInQueue(world);
        assert.deepEqual(verdicts(runtime, queue), [slot(first, 0, "pendingEvaluation"), slot(second, 0, "needsReview")]);
        assert.deepEqual(runtime.confirmQuestionDelivery(student, queue.activityId, queue.input), queue.receipt);
        runtime.evaluatePending();
        const settled = automaticSlot(first, 0, true);
        assert.deepEqual(verdicts(runtime, queue), [settled, slot(second, 0, "needsReview")]);
        const marked = mark(runtime, queue, second, "mark-second", 0, true);
        assert.deepEqual(mark(runtime, queue, second, "mark-second", 0, true), marked);
        assert.throws(() => mark(runtime, queue, second, "mark-second", 0, false), { code: "OPERATION_CONFLICT" });
        runtime.close();

        const reopened = world.open();
        assert.deepEqual(verdicts(reopened, queue), [settled, teacherSlot(second, 1, marked.id, true)]);
        assert.deepEqual(world.evaluated, [first.id]);
      },
    },
    authorize: {
      title: "学生读面不见教师判定与私有键；非指派评阅人、撤权后的评阅人都不能读队列或判定",
      run(world) {
        const { runtime, queue } = handInQueue(world);
        runtime.evaluatePending();
        assert.equal(verdicts(runtime, queue).length, 2);
        mark(runtime, queue, second, "mark-second", 0, false);
        const own = runtime.recoverQuestionDelivery(student, queue.activityId, queue.key, "declared");
        assert.deepEqual(own.receipt, queue.receipt);
        assert.doesNotMatch(JSON.stringify({ own, view: runtime.read(student, queue.activityId) }),
          /契约复核|"source":"teacherReview"|acceptedToken|contract-key/);
        assert.throws(() => runtime.readQuestionDeliveryReview({ ...reviewer, id: "contract-other-reviewer" }, queue.activityId, queue.key,
          "verdicts"), forbidden);
        world.reviewAllowed = false;
        assert.throws(() => verdicts(runtime, queue), forbidden);
        assert.throws(() => mark(runtime, queue, second, "mark-again", 1, true), forbidden);
      },
    },
    failure: {
      title: "自动题评估失败终态后与主观题一同留在队列，教师可分别人工判定",
      run(world) {
        world.failuresLeft = 3;
        const { runtime, queue } = handInQueue(world);
        const scope = { submissionId: queue.receipt.id };
        for (let attempt = 0; attempt < 3; attempt += 1) runtime.evaluatePending(scope);
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
        assert.deepEqual(verdicts(runtime, queue), [slot(first, 0, "evaluationFailed"), slot(second, 0, "needsReview")]);
        const one = mark(runtime, queue, first, "manual-first", 0, true);
        const two = mark(runtime, queue, second, "manual-second", 0, false);
        assert.deepEqual(verdicts(runtime, queue), [teacherSlot(first, 1, one.id, true), teacherSlot(second, 1, two.id, false)]);
        assert.deepEqual(world.evaluated, [first.id, first.id, first.id]);
      },
    },
    withdraw: {
      title: "清除教师判定：自动题回落自动原判、主观题回到待批；陈旧修订清除被拒",
      run(world) {
        const { runtime, queue } = handInQueue(world, "错");
        runtime.evaluatePending();
        assert.deepEqual(verdicts(runtime, queue), [automaticSlot(first, 0, false), slot(second, 0, "needsReview")]);
        const one = mark(runtime, queue, first, "amend-first", 0, true);
        const two = mark(runtime, queue, second, "amend-second", 0, true);
        assert.throws(() => clear(runtime, queue, second, "stale-clear", 0, two.id), { code: "VERDICT_CONFLICT" });
        clear(runtime, queue, first, "clear-first", 1, one.id);
        clear(runtime, queue, second, "clear-second", 1, two.id);
        assert.deepEqual(verdicts(runtime, queue), [automaticSlot(first, 2, false), slot(second, 2, "needsReview")]);
      },
    },
  },
});
