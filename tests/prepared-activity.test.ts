import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import reading from "../practices/reading-library.json" with { type: "json" };
import single from "../practices/single-quote.json" with { type: "json" };
import { publicationSchema } from "../src/contracts/reading.ts";
import { readingPublicationSchema } from "../src/contracts/reading-publication.ts";
import { startActivity } from "../src/kernel/activity.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { saveDraft, submitDraft } from "../src/kernel/submission.ts";
import { openLearningRuntime } from "../src/server.ts";
import type { PreparedActivityVersionInput, PublicationInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase, selectionRanges } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "owner" } as const;
const other = { role: "student", id: "other" } as const;
const open = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;
const [firstStep] = frozenChoicePublication.practice.steps;

function edition(version: number, stepId = firstStep.id) {
  const visible = questions.map(question => ({ ...question, version: questionVersions.get(question.id) }));
  return { practice: {
    ...frozenChoicePublication.practice, version, title: `题目版本 ${version}`, grading: {},
    questions: version === 2 ? visible.toReversed() : visible,
    steps: [{ ...firstStep, id: stepId, submit: { ...firstStep.submit, slots: {
      answers: { ...firstStep.submit.slots.answers, confirmFromDrafts: { allowUnanswered: true } },
    } } }],
  } } satisfies PublicationInput;
}

function replace(stepAttemptId: string, expectedPracticeVersion: number, practiceVersion: number, operationId: string): PreparedActivityVersionInput {
  return { protocolVersion: 1, operationId, stepAttemptId, expectedPracticeVersion, practiceVersion };
}

test("预备换版同卷轮换步骤凭据，跨多次换版恢复原回执并拒绝 ABA 旧写", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(edition(1));
    runtime.publish(edition(2));
    runtime.publish(edition(3, "different-logical-step"));
    const original = runtime.prepare(student, open);
    const change = (input: PreparedActivityVersionInput) => runtime.replacePreparedActivityVersion(student, original.activityId, input);
    const snapshot = () => runtime.read(student, original.activityId);
    assert.throws(() => change(replace(original.stepAttemptId, 2, 1, "wrong-base")), { code: "ACTIVITY_VERSION_CONFLICT" });
    assert.throws(() => change(replace(original.stepAttemptId, 1, 3, "different-step")), { code: "PREPARED_STEP_CHANGED" });
    assert.throws(() => change(replace(original.stepAttemptId, 1, 9, "unpublished")), { status: 404, code: "PRACTICE_NOT_FOUND" });
    const noop = replace(original.stepAttemptId, 1, 1, "same-version");
    assert.deepEqual(change(noop), { ...original, practiceVersion: 1 });

    const upgrade = replace(original.stepAttemptId, 1, 2, "v2");
    using database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER deny_refreeze_receipt BEFORE INSERT ON prepared_activity_version_changes
      BEGIN SELECT RAISE(ABORT, 'prepared receipt unavailable'); END`);
    assert.throws(() => change(upgrade), /prepared receipt unavailable/);
    const unchanged = snapshot();
    assert.ok("formatVersion" in unchanged);
    assert.equal(unchanged.practiceVersion, 1);
    assert.equal(unchanged.stepAttemptId, original.stepAttemptId);
    database.exec("DROP TRIGGER deny_refreeze_receipt");
    const version2 = change(upgrade);
    assert.notEqual(version2.stepAttemptId, original.stepAttemptId);
    assert.deepEqual(change(upgrade), version2);
    const version1 = change(replace(version2.stepAttemptId, 2, 1, "v1-return"));
    assert.notEqual(version1.stepAttemptId, original.stepAttemptId);
    assert.notEqual(version1.stepAttemptId, version2.stepAttemptId);
    assert.deepEqual(change(upgrade), version2);
    assert.deepEqual(change(noop), { ...original, practiceVersion: 1 });
    assert.deepEqual(runtime.prepare(student, open), original);
    assert.deepEqual(runtime.start(student, open), original);
    assert.throws(() => change(replace(original.stepAttemptId, 1, 2, "stale-same-version")), { code: "ACTIVITY_VERSION_CONFLICT" });
    assert.throws(() => change({ ...upgrade, stepAttemptId: version1.stepAttemptId }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => change({ ...upgrade, expectedPracticeVersion: 2 }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => change({ ...upgrade, practiceVersion: 1 }), { code: "OPERATION_CONFLICT" });
    const returned = snapshot();
    assert.ok("formatVersion" in returned);
    assert.equal(returned.practiceVersion, 1);
    assert.equal(returned.stepAttemptId, version1.stepAttemptId);
    assert.equal(returned.step.id, firstStep.id);
    assert.equal(returned.startedAt, original.startedAt);
    assert.equal(runtime.readChoiceDraftActivity(student, original.activityId), undefined);
    assert.deepEqual(database.prepare("SELECT id, step_id, ordinal FROM step_attempts").all().map(row => Object.values(row)),
      [[version1.stepAttemptId, firstStep.id, 0]]);
    for (const [table, count] of [["activities", 1], ["works", 0], ["submissions", 0], ["completions", 0], ["prepared_activity_version_changes", 3]] as const) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, count);
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    runtime.close();
  }
});

test("只允许显式预备的阅读练法，撤权后历史换版回执也拒绝交付", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(edition(1));
    runtime.publish(edition(2));
    runtime.publish(publicationSchema.parse(single));
    const wrongKind = { ...open, practiceId: single.practice.id, practiceVersion: single.practice.version };
    assert.throws(() => runtime.prepare(student, wrongKind), { status: 422, code: "ACTIVITY_NOT_PREPARABLE" });
    const ordinary = runtime.start(student, wrongKind);
    assert.throws(() => runtime.prepare(student, wrongKind), { code: "OPERATION_CONFLICT" });
    assert.throws(() => runtime.replacePreparedActivityVersion(student, ordinary.activityId, replace(ordinary.stepAttemptId, 1, 2, "change")),
      { code: "ACTIVITY_NOT_PREPARED" });
    using database = new DatabaseSync(path);
    const started = startActivity(database, student.id, { ...open, operationId: "managed" }, () => new Date(), "teacher", "prepare");
    const command = replace(started.stepAttemptId, 1, 2, "change");
    assert.throws(() => runtime.replacePreparedActivityVersion(other, started.activityId, command), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => runtime.replacePreparedActivityVersion(student, started.activityId, { ...command, stepAttemptId: randomUUID() }),
      { code: "ACTIVITY_VERSION_CONFLICT" });
    assert.equal(runtime.replacePreparedActivityVersion(student, started.activityId, command).practiceVersion, 2);
    assert.deepEqual(manageReading(database, "teacher", started.activityId, "revokeStudent"), { studentActive: false });
    for (const action of [
      () => runtime.read(student, started.activityId),
      () => runtime.prepare(student, { ...open, operationId: "managed" }),
      () => runtime.start(student, { ...open, operationId: "managed" }),
      () => runtime.replacePreparedActivityVersion(student, started.activityId, command),
    ]) {
      assert.throws(action, { status: 403, code: "FORBIDDEN" });
    }
  } finally {
    runtime.close();
  }
});

test("空答确认和真实步骤推进均结束预备换版资格", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(edition(1));
    runtime.publish(edition(2));
    const blank = runtime.prepare(student, open);
    runtime.confirmChoices(student, blank.activityId, {
      protocolVersion: 1, stepAttemptId: blank.stepAttemptId, operationId: "blank", slotId: "answers",
      questions: questions.map(question => ({
        questionId: question.id, questionVersion: 1, revision: 0, original: { state: "uncollected" },
      })),
    });
    assert.equal(runtime.readChoiceDraftActivity(student, blank.activityId), undefined);
    assert.throws(() => runtime.replacePreparedActivityVersion(student, blank.activityId, replace(blank.stepAttemptId, 1, 2, "blocked")),
      { code: "ACTIVITY_ALREADY_STARTED" });

    const publishedReading = { ...reading, practice: readingPublicationSchema.parse(reading).practice };
    runtime.publish(publishedReading);
    runtime.publish({ ...publishedReading, practice: { ...publishedReading.practice, version: 2 } });
    const readingOpen = runtime.prepare(student, { ...open, operationId: "read", practiceId: reading.practice.id });
    using database = new DatabaseSync(path);
    const first = { protocolVersion: 1, stepAttemptId: readingOpen.stepAttemptId, slotId: "quotes" } as const;
    const saved = saveDraft(database, student.id, readingOpen.activityId, { ...first, ranges: selectionRanges });
    submitDraft(database, student.id, readingOpen.activityId, { ...first, operationId: "quotes", draft: saved.draft }, () => new Date());
    const progressed = runtime.read(student, readingOpen.activityId);
    assert.notEqual(progressed.stepAttemptId, readingOpen.stepAttemptId);
    assert.throws(() => runtime.replacePreparedActivityVersion(student, readingOpen.activityId, replace(progressed.stepAttemptId, 1, 2, "blocked")),
      { code: "ACTIVITY_ALREADY_STARTED" });
  } finally {
    runtime.close();
  }
});
