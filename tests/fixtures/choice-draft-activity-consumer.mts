import { strict as assert } from "node:assert";
import { mock } from "node:test";
import { openLearningRuntime } from "learning-kernel";
import type { ChoiceDraftActivity, ChoiceDraftInput, StudentPrincipal, UnversionedChoiceDraftInput } from "learning-kernel";

const [, , phase] = process.argv;
const owner: StudentPrincipal = { role: "student", id: "draft-activity-owner" };
const other: StudentPrincipal = { role: "student", id: "draft-activity-other" };
const opening = { protocolVersion: 1, practiceId: "library-club", practiceVersion: 1, operationId: "draft-activity" } as const;
const runtime = openLearningRuntime({ databasePath: "learning.sqlite" });

function time(second: number) {
  return new Date(Date.UTC(2026, 10, 19, 1, 0, second)).toISOString();
}

mock.timers.enable({ apis: ["Date"], now: Date.parse(time(0)) });
const at = (second: number) => mock.timers.setTime(Date.parse(time(second)));

try {
  const { activityId, stepAttemptId } = runtime.start(owner, opening);
  const read = (): ChoiceDraftActivity | undefined => runtime.readChoiceDraftActivity(owner, activityId);
  const legacy: UnversionedChoiceDraftInput = {
    protocolVersion: 1, stepAttemptId, slotId: "choices", questionId: "q1", questionVersion: 1, choice: "0",
  };
  const takeover: ChoiceDraftInput = { ...legacy, baseRevision: 1, operationId: "takeover" };
  const changed: ChoiceDraftInput = { ...takeover, baseRevision: 2, operationId: "change", choice: "1" };
  const second: ChoiceDraftInput = { ...takeover, questionId: "q2", baseRevision: 0, operationId: "second", choice: "2" };
  const save = (input: ChoiceDraftInput | UnversionedChoiceDraftInput) => runtime.saveChoiceDraft(owner, activityId, input);
  if (phase === "write") {
    assert.equal(read(), undefined);
    assert.throws(() => runtime.readChoiceDraftActivity(other, activityId), { code: "FORBIDDEN" });
    at(1);
    assert.equal(save(legacy).revision, 1);
    assert.deepEqual(read(), { firstChangedAt: time(1), lastChangedAt: time(1) });
    at(2);
    assert.equal(save(legacy).revision, 2);
    assert.equal(save(takeover).revision, 2);
    assert.throws(() => save({ ...takeover, choice: "2" }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => save({ ...changed, baseRevision: 0 }), { code: "ANSWER_REVISION_CONFLICT" });
    assert.throws(() => save(legacy), { code: "ANSWER_REVISION_CONFLICT" });
    assert.deepEqual(read(), { firstChangedAt: time(1), lastChangedAt: time(1) });
    at(3);
    assert.equal(save(changed).revision, 3);
    assert.deepEqual(read(), { firstChangedAt: time(1), lastChangedAt: time(3) });
    at(4);
    assert.equal(save(takeover).revision, 2);
    assert.deepEqual(read(), { firstChangedAt: time(1), lastChangedAt: time(3) });
    at(5);
    save(second);
    process.exit(49);
  }
  assert.equal(phase, "recover");
  at(30);
  const expected = { firstChangedAt: time(1), lastChangedAt: time(5) };
  assert.deepEqual(read(), expected);
  assert.equal(save(second).revision, 1);
  assert.deepEqual(read(), expected);
  assert.equal(runtime.readChoiceDraftActivity(owner, runtime.start(owner, { ...opening, operationId: "empty-activity" }).activityId), undefined);
  assert.throws(() => runtime.readChoiceDraftActivity(other, activityId), { code: "FORBIDDEN" });
  const receipt = runtime.confirmChoices(owner, activityId, {
    protocolVersion: 1, operationId: "confirm", stepAttemptId, slotId: legacy.slotId,
    questions: [
      { questionId: "q1", questionVersion: 1, revision: 3, original: { state: "uncollected" } },
      { questionId: "q2", questionVersion: 1, revision: 1, original: { state: "uncollected" } },
    ],
  });
  runtime.evaluatePending();
  assert.equal(receipt.stepAttemptId, stepAttemptId);
  assert.deepEqual(read(), expected);
  assert.throws(() => runtime.readChoiceDraftActivity(other, activityId), { code: "FORBIDDEN" });
} finally {
  mock.timers.reset();
  runtime.close();
}
