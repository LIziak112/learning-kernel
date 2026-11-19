import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startActivity } from "../src/kernel/activity.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { saveDraft, submitDraft } from "../src/kernel/submission.ts";
import { readPersonalDraft } from "../src/kernel/work-versions.ts";
import { ChoiceDraftConflict, LearningError, openLearningRuntime } from "../src/server.ts";
import type { ChoiceDraftInput, UnversionedChoiceDraftInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const [firstQuestion, secondQuestion] = questions;
assert.ok(firstQuestion && secondQuestion);
const questionId = firstQuestion.id;
const otherQuestionId = secondQuestion.id;
const initialQuestionVersion = questionVersions.get(questionId);
const otherQuestionVersion = questionVersions.get(otherQuestionId);
assert.ok(initialQuestionVersion && otherQuestionVersion);
const questionVersion = initialQuestionVersion;
const publication = { ...frozenChoicePublication, practice: { ...frozenChoicePublication.practice,
  questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })),
} };
const student = { role: "student", id: "student" } as const;
const other = { role: "student", id: "other" } as const;
const opening = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;

function unversionedChoice(stepAttemptId: string): UnversionedChoiceDraftInput {
  return { protocolVersion: 1, stepAttemptId, slotId: "answers", questionId, questionVersion, choice: "0" };
}

function firstChoice(stepAttemptId: string): ChoiceDraftInput {
  return { ...unversionedChoice(stepAttemptId), operationId: "first", baseRevision: 0 };
}

function denial(status: number, code: string) {
  return (error: unknown) => error instanceof LearningError && error.status === status && error.code === code && !("current" in error);
}

function conflict(revision: number, choice: string | null, code = "ANSWER_REVISION_CONFLICT") {
  return (error: unknown) => {
    assert.ok(error instanceof ChoiceDraftConflict && error.status === 409 && error.code === code);
    assert.deepEqual(error.current, { revision, choice });
    return true;
  };
}

function counts(database: DatabaseSync) {
  return ["works", "work_versions", "choice_draft_operations", "submissions", "performances", "evaluation_tasks"]
    .map(table => database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count);
}

test("分题改稿、陈旧相同答案收敛与原操作重发共享同一冻结事实", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(publication);
    const { activityId, stepAttemptId } = runtime.start(student, opening);
    const sibling = runtime.start(student, { ...opening, operationId: "another-opening" });
    const first = firstChoice(stepAttemptId);
    const save = (input: ChoiceDraftInput) => runtime.saveChoiceDraft(student, activityId, input);
    const before = runtime.read(student, activityId);
    assert.equal("choiceDrafts" in before, false);
    assert.throws(() => runtime.saveChoiceDraft(other, activityId, first), denial(403, "FORBIDDEN"));
    assert.throws(() => save({ ...first, stepAttemptId: sibling.stepAttemptId }), denial(403, "FORBIDDEN"));
    assert.throws(() => save({ ...first, stepAttemptId: randomUUID() }), denial(403, "FORBIDDEN"));
    assert.throws(() => save({ ...first, slotId: "unknown" }), denial(422, "INVALID_SLOT"));
    assert.throws(() => save({ ...first, questionId: "unknown" }), denial(422, "INVALID_QUESTION"));
    assert.throws(() => save({ ...first, questionVersion: first.questionVersion + 1 }), denial(409, "QUESTION_REVISION_STALE"));
    assert.throws(() => save({ ...first, choice: "absent" }), denial(422, "INVALID_CHOICE"));
    assert.throws(() => save({ ...first, baseRevision: -1 }), { name: "ZodError" });
    assert.throws(() => save({ ...first, baseRevision: 1 }), conflict(0, null));
    using database = new DatabaseSync(path);
    assert.deepEqual(counts(database), [0, 0, 0, 0, 0, 0]);

    const revision1 = save(first);
    assert.deepEqual(revision1, { slotId: first.slotId, questionId, questionVersion, choice: "0", revision: 1, changeCount: 1 });
    assert.throws(() => save({ ...first, choice: "2" }), conflict(1, "0", "OPERATION_CONFLICT"));
    const revision2 = save({ ...first, operationId: "second", baseRevision: 1, choice: "1" });
    assert.deepEqual(revision2, { ...revision1, choice: "1", revision: 2, changeCount: 2 });
    assert.deepEqual(save(first), revision1);
    assert.throws(() => runtime.saveChoiceDraft(other, activityId, { ...first, choice: "2" }), denial(403, "FORBIDDEN"));
    assert.throws(() => save({ ...first, choice: "1" }), conflict(2, "1", "OPERATION_CONFLICT"));
    assert.throws(() => save({ ...first, baseRevision: 2 }), conflict(2, "1", "OPERATION_CONFLICT"));
    assert.throws(() => save({ ...first, questionVersion: first.questionVersion + 1 }), denial(409, "OPERATION_CONFLICT"));
    assert.throws(() => save({ ...first, operationId: "stale", choice: "2" }), conflict(2, "1"));
    const converging = { ...first, operationId: "converging", choice: "1" };
    assert.deepEqual(save(converging), revision2);
    assert.deepEqual(save(converging), revision2);
    assert.throws(() => save({ ...converging, choice: "0" }), conflict(2, "1", "OPERATION_CONFLICT"));
    const revisionOther = save({ ...first, questionId: otherQuestionId, questionVersion: otherQuestionVersion });
    assert.deepEqual(revisionOther, { ...revision1, questionId: otherQuestionId, questionVersion: otherQuestionVersion });
    assert.deepEqual(counts(database), [2, 3, 4, 0, 0, 0]);

    const view = runtime.read(student, activityId);
    assert.ok("choiceDrafts" in view);
    assert.deepEqual(view.choiceDrafts, [revision2, revisionOther]);
    assert.doesNotMatch(JSON.stringify(view), /workId|acceptedChoices|scoringKey|solutionMd/);
    assert.throws(() => runtime.read(other, activityId), denial(403, "FORBIDDEN"));
    assert.equal("choiceDrafts" in runtime.read(student, sibling.activityId), false);
    const workId = String(database.prepare("SELECT id FROM works WHERE question_id = ?").get(questionId)?.id);
    assert.throws(() => readPersonalDraft(database, student.id, workId), denial(403, "FORBIDDEN"));
    assert.throws(() => saveDraft(database, student.id, activityId, {
      protocolVersion: 1, stepAttemptId, slotId: first.slotId, workId, choices: {}, references: {},
    }), denial(403, "FORBIDDEN"));
    assert.deepEqual(counts(database), [2, 3, 4, 0, 0, 0]);
  } finally {
    runtime.close();
  }
});

test("旧客户端逐题保存并升版，只有已接受的版本化保存能接管该题", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(publication);
    const { activityId, stepAttemptId } = runtime.start(student, opening);
    const sibling = runtime.start(student, { ...opening, operationId: "sibling" });
    const legacy = unversionedChoice(stepAttemptId);
    const save = (input: UnversionedChoiceDraftInput | ChoiceDraftInput) => runtime.saveChoiceDraft(student, activityId, input);
    for (const incomplete of [{ operationId: "incomplete" }, { baseRevision: 0 }, { operationId: undefined, baseRevision: undefined }]) {
      assert.throws(() => Reflect.apply(runtime.saveChoiceDraft, runtime, [student, activityId, { ...legacy, ...incomplete }]), { name: "ZodError" });
    }
    using database = new DatabaseSync(path);
    assert.equal("choiceDrafts" in runtime.read(student, activityId), false);
    assert.deepEqual(counts(database), [0, 0, 0, 0, 0, 0]);

    const first = save(legacy);
    assert.deepEqual(first, { slotId: legacy.slotId, questionId, questionVersion, choice: "0", revision: 1, changeCount: 1 });
    const modern = { ...legacy, operationId: "takeover", baseRevision: 0 };
    assert.throws(() => save({ ...modern, choice: "1" }), conflict(1, "0"));
    const second = save(legacy);
    assert.deepEqual(second, { ...first, revision: 2, changeCount: 2 });
    assert.deepEqual(counts(database), [1, 2, 0, 0, 0, 0]);

    assert.deepEqual(save(modern), second);
    assert.deepEqual(counts(database), [1, 2, 1, 0, 0, 0]);
    assert.throws(() => save(legacy), conflict(2, "0"));
    const third = save({ ...modern, operationId: "after-takeover", baseRevision: 2, choice: "1" });
    assert.deepEqual(third, { ...first, choice: "1", revision: 3, changeCount: 3 });
    assert.throws(() => save({ ...legacy, choice: "1" }), conflict(3, "1"));
    assert.throws(() => save(legacy), conflict(3, "1"));
    assert.deepEqual(save(modern), second);

    const legacyOther = { ...legacy, questionId: otherQuestionId, questionVersion: otherQuestionVersion };
    const otherFirst = save(legacyOther);
    assert.deepEqual(otherFirst, { ...first, questionId: otherQuestionId, questionVersion: otherQuestionVersion });
    const otherSecond = save({ ...legacyOther, operationId: modern.operationId, baseRevision: 1, choice: "2" });
    assert.deepEqual(otherSecond, { ...otherFirst, choice: "2", revision: 2, changeCount: 2 });
    assert.throws(() => save(legacyOther), conflict(2, "2"));

    assert.throws(() => runtime.saveChoiceDraft(other, activityId, legacy), denial(403, "FORBIDDEN"));
    assert.throws(() => save({ ...legacy, stepAttemptId: sibling.stepAttemptId }), denial(403, "FORBIDDEN"));
    assert.throws(() => save({ ...legacy, questionVersion: questionVersion + 1 }), denial(409, "QUESTION_REVISION_STALE"));
    assert.throws(() => save({ ...legacy, choice: "absent" }), denial(422, "INVALID_CHOICE"));
    const view = runtime.read(student, activityId);
    assert.ok("choiceDrafts" in view);
    assert.deepEqual(view.choiceDrafts, [third, otherSecond]);
    assert.deepEqual(counts(database), [2, 5, 3, 0, 0, 0]);
  } finally {
    runtime.close();
  }
});

test("保存回执写入失败时完整回滚，重发后仍只留下一个草稿版本", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(publication);
    const { activityId, stepAttemptId } = runtime.start(student, opening);
    using database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER reject_draft_receipt BEFORE INSERT ON choice_draft_operations
      BEGIN SELECT RAISE(ABORT, 'draft receipt unavailable'); END`);
    const input = firstChoice(stepAttemptId);
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, input), /draft receipt unavailable/);
    assert.deepEqual(counts(database), [0, 0, 0, 0, 0, 0]);
    database.exec("DROP TRIGGER reject_draft_receipt");
    const receipt = runtime.saveChoiceDraft(student, activityId, input);
    assert.equal(receipt.revision, 1);
    assert.deepEqual(runtime.saveChoiceDraft(student, activityId, input), receipt);
    assert.deepEqual(counts(database), [1, 1, 1, 0, 0, 0]);
  } finally {
    runtime.close();
  }
});

test("旧入口确认后草稿写入关闭，撤权后原操作也不交付本人草稿", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(publication);
    const teacher = "teacher";
    using database = new DatabaseSync(path);
    const { activityId, stepAttemptId } = startActivity(database, student.id, opening, () => new Date(), teacher);
    const input = firstChoice(stepAttemptId);
    const saved = runtime.saveChoiceDraft(student, activityId, input);
    const oldDraft = saveDraft(database, student.id, activityId, {
      protocolVersion: 1, stepAttemptId, slotId: input.slotId, choices: { [questionId]: "1", [otherQuestionId]: "2" }, references: {},
    });
    submitDraft(database, student.id, activityId, {
      protocolVersion: 1, stepAttemptId, slotId: input.slotId, operationId: "legacy-confirm", draft: oldDraft.draft,
    }, () => new Date());
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, { ...input, operationId: "late" }), denial(409, "ALREADY_SUBMITTED"));
    const legacy = unversionedChoice(stepAttemptId);
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, legacy), denial(409, "ALREADY_SUBMITTED"));
    assert.deepEqual(runtime.saveChoiceDraft(student, activityId, input), saved);
    assert.deepEqual(manageReading(database, teacher, activityId, "revokeStudent"), { studentActive: false });
    assert.throws(() => runtime.read(student, activityId), denial(403, "FORBIDDEN"));
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, input), denial(403, "FORBIDDEN"));
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, legacy), denial(403, "FORBIDDEN"));
  } finally {
    runtime.close();
  }
});
