import { strict as assert } from "node:assert";
import {
  deliveryInput, deliveryPublication, evaluatorRef, outsider, override, recoveryKey, reviewer, saveDraft, startFor, student, withdraw,
} from "../fixtures/contracts/delivery.ts";
import type { Runtime } from "../fixtures/contracts/delivery.ts";
import { scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";

const first = stubQuestion("q1");
const second = stubQuestion("q2");
const grading = { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] };
const sourcePractice = "g50-source";
const retryPractice = "g50-retry";
const forbidden = { status: 403, code: "FORBIDDEN" };

function handInSource(runtime: Runtime) {
  runtime.publish(deliveryPublication({ id: sourcePractice, questions: [first, second], mode: "whole", allowUnanswered: true, grading }));
  const source = startFor(runtime, sourcePractice);
  const input = deliveryInput(source, "whole",
    [first, second].map(question => ({ question, revision: saveDraft(runtime, source, question, "错").revision })), "source");
  runtime.confirmQuestionDelivery(student, source.activityId, input);
  runtime.evaluatePending();
  const key = recoveryKey(input);
  return { activityId: source.activityId, key, recovered: runtime.recoverQuestionDelivery(student, source.activityId, key) };
}

function handInRetry(runtime: Runtime, value: string) {
  runtime.publish(deliveryPublication({ id: retryPractice, questions: [first, second], mode: "perQuestion", allowUnanswered: true, grading }));
  const activity = startFor(runtime, retryPractice);
  const saved = saveDraft(runtime, activity, first, value);
  const input = deliveryInput(activity, "question", [{ question: first, revision: saved.revision }], "retry-first");
  return { activityId: activity.activityId, input, key: recoveryKey(input), receipt: runtime.confirmQuestionDelivery(student, activity.activityId, input) };
}
type Retry = ReturnType<typeof handInRetry>;

function verdicts(runtime: Runtime, retry: Retry) {
  return runtime.readQuestionDeliveryReview(reviewer, retry.activityId, retry.key, "verdicts").questions;
}

const position = { questionId: first.id, questionVersion: first.version };

type Clause = (world: StubWorld, runtime: Runtime, retry: Retry) => Runtime;
function afterWrongSource(value: string, clause: Clause, failures = 0) {
  return (world: StubWorld) => {
    const runtime = world.open();
    const source = handInSource(runtime);
    const evaluatedBefore = world.evaluated.length;
    world.failuresLeft = failures;
    const current = clause(world, runtime, handInRetry(runtime, value));
    assert.ok(world.evaluated.slice(evaluatedBefore).every(id => id === first.id), "重练之外不应再评估原卷");
    world.recoveryAllowed = true;
    assert.deepEqual(current.recoverQuestionDelivery(student, source.activityId, source.key), source.recovered);
    assert.equal(current.read(student, source.activityId).status, "completed");
  };
}

scenarioContract({
  group: "G50",
  items: {
    submit: {
      title: "错题重练是新的逐题活动：回执可重发取回、竞争交付被拒，评估后判分、跨开库读回；原卷回执与判分不变",
      run: afterWrongSource("甲", (world, runtime, retry) => {
        assert.match(retry.receipt.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(retry.receipt.stepAttemptId, retry.key.stepAttemptId);
        assert.deepEqual(runtime.confirmQuestionDelivery(student, retry.activityId, retry.input), retry.receipt);
        assert.throws(() => runtime.confirmQuestionDelivery(student, retry.activityId, { ...retry.input, operationId: "competing" }),
          { status: 409, code: "ALREADY_SUBMITTED" });
        const pending = runtime.recoverQuestionDelivery(student, retry.activityId, retry.key);
        assert.deepEqual(pending.confirmation.questions.map(({ questionId, questionVersion, revision, value }) =>
          ({ questionId, questionVersion, revision, value })), [{ ...position, revision: 1, value: "甲" }]);
        assert.deepEqual(pending.evaluation, { status: "pending", evaluator: evaluatorRef });
        const evaluatedBefore = world.evaluated.length;
        runtime.evaluatePending();
        const evaluated = runtime.recoverQuestionDelivery(student, retry.activityId, retry.key);
        assert.deepEqual(evaluated.receipt, retry.receipt);
        assert.ok(evaluated.evaluation.status === "evaluated");
        assert.deepEqual(evaluated.evaluation.questions, [{ ...position, result: { status: "judged", correct: true } }]);
        runtime.close();

        const reopened = world.open();
        assert.deepEqual(reopened.confirmQuestionDelivery(student, retry.activityId, retry.input), retry.receipt);
        assert.deepEqual(reopened.recoverQuestionDelivery(student, retry.activityId, retry.key), evaluated);
        assert.equal(reopened.evaluatePending().evaluated, 0);
        assert.equal(world.evaluated.length - evaluatedBefore, 1);
        return reopened;
      }),
    },
    authorize: {
      title: "重练回执只有本人可取回、不泄露私有键；他人、非指派评阅人、撤权后都被拒；原卷不受影响",
      run: afterWrongSource("甲", (world, runtime, retry) => {
        runtime.evaluatePending();
        const leak = /acceptedToken|acceptedByQuestion|contract-key/;
        const own = runtime.recoverQuestionDelivery(student, retry.activityId, retry.key);
        assert.deepEqual(own.receipt, retry.receipt);
        assert.doesNotMatch(JSON.stringify(own), leak);
        assert.doesNotMatch(JSON.stringify(runtime.read(student, retry.activityId)), leak);
        assert.deepEqual(verdicts(runtime, retry).map(({ questionId }) => questionId), [first.id]);
        assert.throws(() => runtime.recoverQuestionDelivery(outsider, retry.activityId, retry.key), forbidden);
        assert.throws(() => runtime.confirmQuestionDelivery(outsider, retry.activityId, retry.input), forbidden);
        assert.throws(() => runtime.readQuestionDeliveryReview({ ...reviewer, id: "contract-other-reviewer" }, retry.activityId, retry.key,
          "verdicts"), forbidden);
        world.reviewAllowed = false;
        assert.throws(() => verdicts(runtime, retry), forbidden);
        world.recoveryAllowed = false;
        assert.throws(() => runtime.recoverQuestionDelivery(student, retry.activityId, retry.key), forbidden);
        world.reviewAllowed = true;
        return runtime;
      }),
    },
    failure: {
      title: "重练评估连续失败三次转失败终态，学生只见失败、教师可人工判定；原卷判分不变",
      run: afterWrongSource("甲", (world, runtime, retry) => {
        const scope = { submissionId: retry.receipt.id };
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 1, deferred: 0 });
        assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
        assert.deepEqual(world.evaluated.slice(-3), [first.id, first.id, first.id]);
        assert.deepEqual(runtime.recoverQuestionDelivery(student, retry.activityId, retry.key).evaluation,
          { status: "failed", evaluator: evaluatorRef });
        assert.doesNotMatch(JSON.stringify(runtime.read(student, retry.activityId)), /桩评估器故障|EVALUATOR_FAILED/);
        assert.deepEqual(verdicts(runtime, retry), [{ ...position, revision: 0, status: "evaluationFailed" }]);
        const manual = runtime.writeQuestionDeliveryVerdict(reviewer, retry.activityId, retry.key,
          override({ receipt: retry.receipt, questionId: first.id, operationId: "manual", expectedRevision: 0 }, true));
        assert.deepEqual(verdicts(runtime, retry), [{ ...position, revision: 1, status: "judged",
          effective: { source: "teacherReview", id: manual.id, correct: true } }]);
        return runtime;
      }, 3),
    },
    withdraw: {
      title: "重练上的教师改判清除后回落自动原判，学生读面不变；原卷判分不变",
      run: afterWrongSource("错", (_world, runtime, retry) => {
        runtime.evaluatePending();
        const before = verdicts(runtime, retry);
        const studentBefore = runtime.recoverQuestionDelivery(student, retry.activityId, retry.key);
        assert.deepEqual(before, [{ ...position, revision: 0, status: "judged",
          automatic: { correct: false, valid: true }, effective: { source: "automatic", correct: false } }]);
        const location = { receipt: retry.receipt, questionId: first.id };
        const mark = runtime.writeQuestionDeliveryVerdict(reviewer, retry.activityId, retry.key,
          override({ ...location, operationId: "amend", expectedRevision: 0 }, true));
        assert.deepEqual(verdicts(runtime, retry), before.map(verdict => ({ ...verdict, revision: 1,
          effective: { source: "teacherReview", id: mark.id, correct: true } })));
        runtime.writeQuestionDeliveryVerdict(reviewer, retry.activityId, retry.key,
          withdraw({ ...location, operationId: "clear", expectedRevision: 1 }, mark.id));
        assert.deepEqual(verdicts(runtime, retry), before.map(verdict => ({ ...verdict, revision: 2 })));
        assert.deepEqual(runtime.recoverQuestionDelivery(student, retry.activityId, retry.key), studentBefore);
        return runtime;
      }),
    },
  },
});
