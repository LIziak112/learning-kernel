import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startActivity } from "../src/kernel/activity.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { openLearningRuntime } from "../src/server.ts";
import type { ChoiceConfirmationInput, ChoiceDraftInput, PublicationInput, UnversionedChoiceDraftInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const owner = { role: "student", id: "owner" } as const;
const other = { role: "student", id: "other" } as const;
const opening = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;
const [first, second] = questions;
assert.ok(first && second);
const firstId = first.id;
const secondId = second.id;
const [step] = frozenChoicePublication.practice.steps;
const publication = { practice: {
  ...frozenChoicePublication.practice,
  questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })),
  steps: [{ ...step, submit: { ...step.submit, slots: {
    answers: { ...step.submit.slots.answers, confirmFromDrafts: { allowUnanswered: true } },
  } } }],
  grading: {},
  policy: { ...frozenChoicePublication.practice.policy, student: {
    ownSubmission: { ...frozenChoicePublication.practice.policy.student.ownSubmission, fields: ["receipt"] },
  } },
} } satisfies PublicationInput;

function selection(stepAttemptId: string): UnversionedChoiceDraftInput {
  return { protocolVersion: 1, stepAttemptId, slotId: "answers", questionId: firstId, questionVersion: 1, choice: "0" };
}

function time(second: number) {
  return new Date(Date.UTC(2026, 10, 19, 8, 0, second)).toISOString();
}

test("升级旧草稿保留未知首次时刻，旧写同文和接管不会补写时间", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(time(0)) });
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  let opened;
  let empty;
  try {
    runtime.publish(publication);
    opened = runtime.start(owner, opening);
    empty = runtime.start(owner, { ...opening, operationId: "empty-before-upgrade" });
    t.mock.timers.setTime(Date.parse(time(1)));
    assert.equal(runtime.saveChoiceDraft(owner, opened.activityId, selection(opened.stepAttemptId)).revision, 1);
  } finally {
    runtime.close();
  }
  {
    using priorSchema = new DatabaseSync(path);
    priorSchema.exec(`
      ALTER TABLE activities DROP COLUMN first_choice_changed_at;
      ALTER TABLE activities DROP COLUMN last_choice_changed_at;
      DROP TABLE choice_draft_latest_operations;
      DELETE FROM schema_migrations WHERE version IN (11, 12);
    `);
  }
  const upgraded = openLearningRuntime({ databasePath: path });
  const { activityId, stepAttemptId } = opened;
  try {
    const historical = { firstChangedAt: null, lastChangedAt: null };
    assert.deepEqual(upgraded.readChoiceDraftActivity(owner, activityId), historical);
    assert.equal(upgraded.readChoiceDraftActivity(owner, empty.activityId), undefined);
    t.mock.timers.setTime(Date.parse(time(2)));
    assert.equal(upgraded.saveChoiceDraft(owner, activityId, selection(stepAttemptId)).revision, 2);
    assert.deepEqual(upgraded.readChoiceDraftActivity(owner, activityId), historical);
    const versioned = { ...selection(stepAttemptId), baseRevision: 2, operationId: "versioned" };
    assert.equal(upgraded.saveChoiceDraft(owner, activityId, versioned).revision, 2);
    assert.deepEqual(upgraded.readChoiceDraftActivity(owner, activityId), historical);
    t.mock.timers.setTime(Date.parse(time(3)));
    assert.equal(upgraded.saveChoiceDraft(owner, activityId, { ...versioned, operationId: "change", choice: "1" }).revision, 3);
    assert.deepEqual(upgraded.readChoiceDraftActivity(owner, activityId), { ...historical, lastChangedAt: time(3) });
    t.mock.timers.setTime(Date.parse(time(4)));
    assert.equal(upgraded.saveChoiceDraft(owner, empty.activityId, selection(empty.stepAttemptId)).revision, 1);
    assert.deepEqual(upgraded.readChoiceDraftActivity(owner, empty.activityId), { firstChangedAt: time(4), lastChangedAt: time(4) });
  } finally {
    upgraded.close();
  }
  const reopened = openLearningRuntime({ databasePath: path });
  try {
    assert.deepEqual(reopened.readChoiceDraftActivity(owner, activityId), { firstChangedAt: null, lastChangedAt: time(3) });
    assert.throws(() => reopened.readChoiceDraftActivity(other, activityId), { status: 403, code: "FORBIDDEN" });
  } finally {
    reopened.close();
  }
});

test("草稿时间与工作版本及操作回执一起回滚，确认和撤权仍按当前权限交付", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(time(0)) });
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(publication);
    using database = new DatabaseSync(path);
    const { activityId, stepAttemptId } = startActivity(database, owner.id, opening, () => new Date(), "teacher");
    const read = () => runtime.readChoiceDraftActivity(owner, activityId);
    const record = database.prepare("SELECT first_choice_changed_at, last_choice_changed_at FROM activities WHERE id = ?");
    const draft: ChoiceDraftInput = { ...selection(stepAttemptId), baseRevision: 0, operationId: "first" };
    const save = (command: ChoiceDraftInput) => runtime.saveChoiceDraft(owner, activityId, command);
    assert.equal(read(), undefined);
    assert.throws(() => runtime.saveChoiceDraft(other, activityId, draft), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => Reflect.apply(runtime.readChoiceDraftActivity, runtime, [{ role: "reviewer", id: "teacher" }, activityId]),
      { status: 403, code: "FORBIDDEN" });
    const breakReceipt = `CREATE TRIGGER deny_draft_operation BEFORE INSERT ON choice_draft_operations
      BEGIN SELECT RAISE(ABORT, 'draft operation aborted'); END`;
    database.exec(breakReceipt);
    t.mock.timers.setTime(Date.parse(time(1)));
    assert.throws(() => save(draft), /draft operation aborted/);
    assert.equal(read(), undefined);
    assert.deepEqual(Object.values(record.get(activityId) ?? {}), [null, null]);
    database.exec("DROP TRIGGER deny_draft_operation");
    t.mock.timers.setTime(Date.parse(time(2)));
    const accepted = save(draft);
    assert.equal(accepted.revision, 1);
    const expected = { firstChangedAt: time(2), lastChangedAt: time(2) };
    assert.deepEqual(read(), expected);
    const change = { ...draft, baseRevision: 1, operationId: "later", choice: "1" };
    database.exec(breakReceipt);
    t.mock.timers.setTime(Date.parse(time(3)));
    assert.deepEqual(save(draft), accepted);
    assert.throws(() => save({ ...change, baseRevision: 0 }), { status: 409, code: "ANSWER_REVISION_CONFLICT" });
    assert.deepEqual(read(), expected);
    assert.throws(() => save(change), /draft operation aborted/);
    assert.deepEqual(read(), expected);
    const active = runtime.read(owner, activityId);
    assert.ok("choiceDrafts" in active);
    assert.deepEqual(active.choiceDrafts, [accepted]);
    database.exec("DROP TRIGGER deny_draft_operation");

    const complete = (stepAttemptId: string, firstRevision: number): ChoiceConfirmationInput => ({
      protocolVersion: 1, operationId: "confirm", stepAttemptId, slotId: draft.slotId,
      questions: [firstId, secondId].map((questionId, index) => ({
        questionId, questionVersion: 1, revision: index === 0 ? firstRevision : 0, original: { state: "uncollected" },
      })),
    });
    t.mock.timers.setTime(Date.parse(time(4)));
    const receipt = runtime.confirmChoices(owner, activityId, complete(stepAttemptId, 1));
    assert.deepEqual(runtime.read(owner, activityId).submission, { receipt });
    assert.deepEqual(read(), expected);
    assert.throws(() => save(change), { status: 409, code: "ALREADY_SUBMITTED" });
    assert.deepEqual(read(), expected);
    const empty = runtime.start(owner, { ...opening, operationId: "empty" });
    runtime.confirmChoices(owner, empty.activityId, complete(empty.stepAttemptId, 0));
    assert.equal(runtime.readChoiceDraftActivity(owner, empty.activityId), undefined);
    assert.deepEqual(manageReading(database, "teacher", activityId, "revokeStudent"), { studentActive: false });
    assert.throws(read, { status: 403, code: "FORBIDDEN" });
  } finally {
    runtime.close();
  }
});
