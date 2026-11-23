import { strict as assert } from "node:assert";
import { ChoiceDraftConflict, openLearningRuntime } from "learning-kernel";
import type { StudentPrincipal, UnversionedChoiceDraftInput } from "learning-kernel";

const [, , phase, expected] = process.argv;
const owner: StudentPrincipal = { role: "student", id: "migration-compatibility-owner" };
const runtime = openLearningRuntime({ databasePath: "learning.sqlite" });

try {
  const { activityId, stepAttemptId } = runtime.start(owner, {
    protocolVersion: 1, practiceId: "library-club", practiceVersion: 1, operationId: "unversioned-choice-activity",
  });
  const legacy: UnversionedChoiceDraftInput = {
    protocolVersion: 1, stepAttemptId, slotId: "choices", questionId: "q1", questionVersion: 1, choice: "0",
  };
  const modern = { ...legacy, baseRevision: 2, operationId: "versioned-takeover" };
  const save = (input: typeof legacy | typeof modern) => runtime.saveChoiceDraft(owner, activityId, input);
  if (phase === "init") {
    assert.equal("choiceDrafts" in runtime.read(owner, activityId), false);
    for (const revision of [1, 2]) {
      assert.deepEqual(save(legacy), { slotId: "choices", questionId: "q1", questionVersion: 1, choice: "0", revision, changeCount: revision });
    }
  } else if (phase === "legacy") {
    try {
      const receipt = save(legacy);
      assert.equal(receipt.revision, 3);
      assert.equal(receipt.changeCount, 3);
      console.log("wrote");
    } catch (error) {
      assert.ok(error instanceof ChoiceDraftConflict);
      assert.equal(error.code, "ANSWER_REVISION_CONFLICT");
      assert.deepEqual(error.current, { revision: 2, choice: "0" });
      console.log("stopped");
    }
  } else if (phase === "modern") {
    const receipt = save(modern);
    assert.equal(receipt.changeCount, receipt.revision);
    console.log(receipt.revision);
  } else {
    assert.equal(phase, "recover");
    assert.ok(expected === "2" || expected === "3");
    const revision = Number(expected);
    const view = runtime.read(owner, activityId);
    assert.ok("choiceDrafts" in view);
    const head = { slotId: "choices", questionId: "q1", questionVersion: 1, choice: "0", revision, changeCount: revision };
    assert.deepEqual(view.choiceDrafts, [head]);
    assert.deepEqual(save(modern), head);
    assert.throws(() => save(legacy), error => {
      assert.ok(error instanceof ChoiceDraftConflict);
      assert.equal(error.status, 409);
      assert.deepEqual(error.current, { revision, choice: "0" });
      return true;
    });
    const confirmed = runtime.confirmChoices(owner, activityId, {
      protocolVersion: 1, operationId: "confirm-after-takeover", stepAttemptId, slotId: legacy.slotId,
      questions: [
        { questionId: "q1", questionVersion: 1, revision, original: { state: "uncollected" } },
        { questionId: "q2", questionVersion: 1, revision: 0, original: { state: "uncollected" } },
      ],
    });
    runtime.evaluatePending();
    const completed = runtime.read(owner, activityId);
    assert.equal(completed.status, "completed");
    assert.ok("formatVersion" in completed);
    assert.deepEqual(completed.submission?.receipt, confirmed);
    const questions = completed.submission?.confirmation?.questions;
    assert.deepEqual(questions?.map(question => [question.choice, question.revision]), [["0", revision], [null, 0]]);
  }
} finally {
  runtime.close();
}
