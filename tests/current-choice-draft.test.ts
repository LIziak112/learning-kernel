import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startActivity } from "../src/kernel/activity.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { ChoiceDraftConflict, LearningError, openLearningRuntime } from "../src/server.ts";
import type { ChoiceDraftInput, UnversionedChoiceDraftInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const owner = { role: "student", id: "owner" } as const;
const other = { role: "student", id: "other" } as const;
const opening = { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: "open" } as const;
const [first, second] = questions;
assert.ok(first && second);
const firstId = first.id;
const secondId = second.id;
const publication = {
  ...frozenChoicePublication,
  practice: { ...frozenChoicePublication.practice, questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })) },
};
const time = (second: number) => new Date(Date.UTC(2026, 10, 19, 1, 0, second)).toISOString();

function deny(code: string, status = 409) {
  return (error: unknown) => error instanceof LearningError && error.code === code && error.status === status && !("current" in error);
}

function conflict(revision: number, choice: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChoiceDraftConflict && error.code === "ANSWER_REVISION_CONFLICT");
    assert.deepEqual(error.current, { revision, choice });
    return true;
  };
}

function unversioned(stepAttemptId: string, questionId = firstId): UnversionedChoiceDraftInput {
  return { protocolVersion: 1, stepAttemptId, slotId: "answers", questionId, questionVersion: 1, choice: "0" };
}

test("旧库仅恢复当前修订可证的最近操作，歧义由后续普通同文保存确定", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  let opened;
  try {
    runtime.publish(publication);
    opened = runtime.start(owner, opening);
    const { activityId, stepAttemptId } = opened;
    const a = { ...unversioned(stepAttemptId), baseRevision: 0, operationId: "A" };
    const b = { ...a, baseRevision: 1, operationId: "B", choice: "1" };
    assert.equal(runtime.saveChoiceDraft(owner, activityId, a).revision, 1);
    assert.equal(runtime.saveChoiceDraft(owner, activityId, b).revision, 2);
    const otherA = { ...a, questionId: secondId };
    const otherB = { ...otherA, operationId: "B" };
    assert.equal(runtime.saveChoiceDraft(owner, activityId, otherA).revision, 1);
    assert.equal(runtime.saveChoiceDraft(owner, activityId, otherB).revision, 1);
  } finally {
    runtime.close();
  }

  {
    using legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE choice_draft_latest_operations;
      DROP TABLE prepared_activity_version_changes;
      ALTER TABLE activities DROP COLUMN initial_prepared_step_attempt_id;
      ALTER TABLE activities DROP COLUMN initial_prepared_practice_version;
      DROP TABLE choice_snapshot_revisions;
      DROP TABLE choice_draft_amendments;
      DROP TABLE response_review_requirements;
      DROP TABLE self_assessment_events;
      DROP TABLE activity_restarts;
      DELETE FROM schema_migrations WHERE version >= 12;
    `);
  }
  const reopened = openLearningRuntime({ databasePath: path });
  try {
    const { activityId, stepAttemptId } = opened;
    const a = { ...unversioned(stepAttemptId), baseRevision: 0, operationId: "A" };
    const b = { ...a, baseRevision: 1, operationId: "B", choice: "1" };
    const otherA = { ...a, questionId: secondId };
    const otherB = { ...otherA, operationId: "B" };
    const replay = (input: ChoiceDraftInput) => reopened.saveCurrentChoiceDraft(owner, activityId, input, "replayLatestOnly");
    const times = reopened.readChoiceDraftActivity(owner, activityId);
    assert.throws(() => replay(a), deny("DRAFT_REPLAY_REQUIRED"));
    assert.doesNotThrow(() => assert.equal(replay({ ...b, baseRevision: 99 }).revision, 2));
    assert.throws(() => replay(otherA), deny("DRAFT_REPLAY_REQUIRED"));
    assert.throws(() => replay(otherB), deny("DRAFT_REPLAY_REQUIRED"));
    const exact = reopened.saveChoiceDraft(owner, activityId, otherA);
    assert.deepEqual([exact.revision, exact.choice], [1, "0"]);
    assert.throws(() => replay(otherA), deny("DRAFT_REPLAY_REQUIRED"));
    assert.deepEqual(reopened.saveCurrentChoiceDraft(owner, activityId, { ...otherA, baseRevision: 8 }), exact);
    assert.deepEqual(replay(otherA), exact);
    assert.throws(() => replay(otherB), deny("DRAFT_REPLAY_REQUIRED"));
    assert.deepEqual(reopened.readChoiceDraftActivity(owner, activityId), times);
  } finally {
    reopened.close();
  }
});

test("混用保留盲写接管和原回执，写入最近操作失败时稿、回执和实质时间同时回滚", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(time(0)) });
  const at = (second: number) => t.mock.timers.setTime(Date.parse(time(second)));
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(publication);
    using database = new DatabaseSync(path);
    const { activityId, stepAttemptId } = startActivity(database, owner.id, opening, () => new Date(), "teacher");
    const raw = unversioned(stepAttemptId);
    const a = { ...raw, operationId: "A", baseRevision: 0 };
    const b = { ...a, operationId: "B", baseRevision: 2, choice: "1" };
    const c = { ...a, operationId: "A", baseRevision: 3, choice: "2" };
    const replay = (input: ChoiceDraftInput | UnversionedChoiceDraftInput) =>
      runtime.saveCurrentChoiceDraft(owner, activityId, input, "replayLatestOnly");
    assert.throws(() => Reflect.apply(runtime.saveCurrentChoiceDraft, runtime, [owner, activityId, a, "unknown"]), { name: "ZodError" });
    assert.throws(() => replay(raw), deny("DRAFT_REPLAY_REQUIRED"));
    assert.throws(() => replay(a), deny("DRAFT_REPLAY_REQUIRED"));
    assert.throws(() => runtime.saveCurrentChoiceDraft(other, activityId, a), deny("FORBIDDEN", 403));
    assert.equal(runtime.readChoiceDraftActivity(owner, activityId), undefined);
    at(1);
    assert.equal(runtime.saveCurrentChoiceDraft(owner, activityId, raw).revision, 1);
    at(2);
    assert.equal(runtime.saveChoiceDraft(owner, activityId, raw).revision, 2);
    const first = runtime.saveCurrentChoiceDraft(owner, activityId, a);
    assert.equal(first.revision, 2);
    assert.throws(() => runtime.saveCurrentChoiceDraft(owner, activityId, raw), conflict(2, "0"));
    assert.throws(() => runtime.saveChoiceDraft(owner, activityId, raw), conflict(2, "0"));
    assert.throws(() => replay(raw), deny("DRAFT_REPLAY_REQUIRED"));
    assert.deepEqual(runtime.readChoiceDraftActivity(owner, activityId), { firstChangedAt: time(1), lastChangedAt: time(1) });
    const second = runtime.saveChoiceDraft(owner, activityId, b);
    assert.equal(second.revision, 3);
    assert.doesNotThrow(() => assert.deepEqual(replay(b), second));
    assert.doesNotThrow(() => assert.deepEqual(runtime.saveChoiceDraft(owner, activityId, a), first));
    assert.throws(() => replay(a), deny("DRAFT_REPLAY_REQUIRED"));
    at(3);
    database.exec(`CREATE TRIGGER reject_latest_operation BEFORE UPDATE ON choice_draft_latest_operations
      BEGIN SELECT RAISE(ABORT, 'latest operation unavailable'); END`);
    assert.throws(() => runtime.saveCurrentChoiceDraft(owner, activityId, c), /latest operation unavailable/);
    assert.doesNotThrow(() => assert.deepEqual(replay(b), second));
    assert.throws(() => replay(c), deny("DRAFT_REPLAY_REQUIRED"));
    const view = runtime.read(owner, activityId);
    assert.ok("choiceDrafts" in view);
    assert.deepEqual(view.choiceDrafts, [second]);
    assert.deepEqual(runtime.readChoiceDraftActivity(owner, activityId), { firstChangedAt: time(1), lastChangedAt: time(2) });
    for (const [table, count] of [["work_versions", 3], ["choice_draft_operations", 2], ["choice_draft_latest_operations", 1]] as const) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, count);
    }
    database.exec("DROP TRIGGER reject_latest_operation");
    at(4);
    const third = runtime.saveCurrentChoiceDraft(owner, activityId, c);
    assert.deepEqual([third.revision, third.choice], [4, "2"]);
    assert.deepEqual(replay(c), third);
    assert.throws(() => replay({ ...c, choice: "1" }), conflict(4, "2"));
    assert.doesNotThrow(() => assert.deepEqual(runtime.saveChoiceDraft(owner, activityId, a), first));
    assert.throws(() => runtime.saveChoiceDraft(owner, activityId, c), { code: "OPERATION_CONFLICT" });
    assert.deepEqual(runtime.readChoiceDraftActivity(owner, activityId), { firstChangedAt: time(1), lastChangedAt: time(4) });
    assert.deepEqual(manageReading(database, "teacher", activityId, "revokeStudent"), { studentActive: false });
    assert.throws(() => replay(c), deny("FORBIDDEN", 403));
    assert.throws(() => runtime.saveCurrentChoiceDraft(owner, activityId, c), deny("FORBIDDEN", 403));
  } finally {
    runtime.close();
  }
});
