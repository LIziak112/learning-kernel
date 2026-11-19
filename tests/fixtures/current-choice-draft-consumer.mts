import { strict as assert } from "node:assert";
import { mock } from "node:test";
import { ChoiceDraftConflict, LearningError, openLearningRuntime } from "learning-kernel";
import type { ChoiceDraftInput } from "learning-kernel";

const [, , phase, winner] = process.argv;
const owner = { role: "student", id: "current-choice-owner" } as const;
const other = { role: "student", id: "current-choice-other" } as const;
const runtime = openLearningRuntime({ databasePath: "learning.sqlite" });
const opening = { protocolVersion: 1, operationId: phase?.startsWith("race-") ? "competing" : "exercise", practiceId: "library-club", practiceVersion: 1 } as const;
const time = (second: number) => new Date(Date.UTC(2026, 10, 19, 1, 0, second)).toISOString();
mock.timers.enable({ apis: ["Date"], now: Date.parse(time(0)) });
const at = (second: number) => mock.timers.setTime(Date.parse(time(second)));

function conflict(revision: number, choice: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChoiceDraftConflict);
    assert.equal(error.code, "ANSWER_REVISION_CONFLICT");
    assert.deepEqual(error.current, { revision, choice });
    return true;
  };
}

function denied(code: string, status = 409) {
  return (error: unknown) => error instanceof LearningError && error.code === code && error.status === status && !("current" in error);
}

try {
  const { activityId, stepAttemptId } = runtime.start(owner, opening);
  const input = (operationId: string, baseRevision: number, choice: string, questionId = "q1"): ChoiceDraftInput => ({
    protocolVersion: 1, stepAttemptId, slotId: "choices", questionId, questionVersion: 1, operationId, baseRevision, choice,
  });
  const a = input("A", 0, "0");
  const b = input("B", 1, "1");
  const c = input("C", 2, "0");
  const save = (request: ChoiceDraftInput) => runtime.saveCurrentChoiceDraft(owner, activityId, request);
  const replay = (request: ChoiceDraftInput) => runtime.saveCurrentChoiceDraft(owner, activityId, request, "replayLatestOnly");
  const times = () => runtime.readChoiceDraftActivity(owner, activityId);
  if (phase === "race-prepare") {
    assert.equal(save(a).revision, 1);
  } else if (phase === "race-one" || phase === "race-two") {
    const choice = phase === "race-one" ? "1" : "2";
    try {
      const result = save(input(phase, 1, choice));
      assert.deepEqual([result.revision, result.choice], [2, choice]);
      console.log(phase);
    } catch (error) {
      assert.ok(conflict(2, choice === "1" ? "2" : "1")(error));
      console.log("lost");
    }
  } else if (phase === "race-recover") {
    assert.ok(winner === "race-one" || winner === "race-two");
    const winningChoice = winner === "race-one" ? "1" : "2";
    assert.deepEqual(replay(input(winner, 0, winningChoice)), {
      slotId: "choices", questionId: "q1", questionVersion: 1, revision: 2, changeCount: 2, choice: winningChoice,
    });
    const losingOperation = winner === "race-one" ? "race-two" : "race-one";
    assert.throws(() => replay(input(losingOperation, 2, winningChoice)), denied("DRAFT_REPLAY_REQUIRED"));
  } else if (phase === "write") {
    assert.equal(times(), undefined);
    at(1);
    const first = save(a);
    assert.equal(first.revision, 1);
    assert.deepEqual(save({ ...a, baseRevision: 99 }), first);
    assert.throws(() => save({ ...a, choice: "2" }), conflict(1, "0"));
    at(2);
    assert.equal(save(b).revision, 2);
    assert.throws(() => save(a), conflict(2, "1"));
    assert.deepEqual(runtime.saveChoiceDraft(owner, activityId, a), first);
    at(3);
    const restored = save(c);
    assert.equal(restored.revision, 3);
    assert.deepEqual(save(a), restored);
    assert.deepEqual(replay({ ...a, baseRevision: 8 }), restored);
    assert.deepEqual(runtime.saveChoiceDraft(owner, activityId, a), first);
    at(4);
    const otherA = input("A", 0, "0", "q2");
    assert.equal(save(otherA).revision, 1);
    assert.equal(save(input("B", 1, "1", "q2")).revision, 2);
    const reused = save(input("A", 2, "2", "q2"));
    assert.deepEqual([reused.revision, reused.choice], [3, "2"]);
    const exact = runtime.saveChoiceDraft(owner, activityId, otherA);
    assert.deepEqual([exact.revision, exact.choice], [1, "0"]);
    assert.throws(() => runtime.saveCurrentChoiceDraft(other, activityId, a), denied("FORBIDDEN", 403));
  } else {
    assert.equal(phase, "recover");
    at(30);
    const latest = replay({ ...a, baseRevision: 80 });
    assert.deepEqual([latest.revision, latest.changeCount, latest.choice], [3, 3, "0"]);
    assert.throws(() => replay(c), denied("DRAFT_REPLAY_REQUIRED"));
    assert.throws(() => replay(input("new", 3, "0")), denied("DRAFT_REPLAY_REQUIRED"));
    assert.throws(() => replay({ ...a, choice: "2" }), conflict(3, "0"));
    assert.throws(() => replay({ ...a, questionVersion: 2 }), denied("QUESTION_REVISION_STALE"));
    assert.throws(() => runtime.saveCurrentChoiceDraft(other, activityId, a, "replayLatestOnly"), denied("FORBIDDEN", 403));
    const second = replay(input("A", 0, "2", "q2"));
    assert.deepEqual([second.revision, second.choice], [3, "2"]);
    assert.throws(() => replay(input("A", 0, "0", "q2")), conflict(3, "2"));
    assert.deepEqual(times(), { firstChangedAt: time(1), lastChangedAt: time(4) });
    runtime.confirmChoices(owner, activityId, {
      protocolVersion: 1, operationId: "confirm", stepAttemptId, slotId: "choices",
      questions: ["q1", "q2"].map(questionId => ({ questionId, questionVersion: 1, revision: 3, original: { state: "uncollected" } })),
    });
    assert.throws(() => save(a), denied("ALREADY_SUBMITTED"));
    assert.throws(() => replay(a), denied("ALREADY_SUBMITTED"));
    const exact = runtime.saveChoiceDraft(owner, activityId, a);
    assert.deepEqual([exact.revision, exact.choice], [1, "0"]);
  }
} finally {
  mock.timers.reset();
  runtime.close();
}
