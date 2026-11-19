import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime, verifyActivityBindings } from "../src/server.ts";
import type { ActivityBindingClaims, TeacherAmendmentBinding } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const { practice } = frozenChoicePublication;
const [question] = questions;
assert.ok(question);
const questionId = question.id;
const publication = { practice: { ...practice, grading: {}, questions: questions.map(question => ({
  ...question, version: questionVersions.get(question.id),
})) } };
const student = { role: "student", id: "student" } as const;
const teacher = { role: "reviewer", id: "teacher" } as const;
const other = { role: "student", id: "other" } as const;
const open = { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: "opening" } as const;
const mismatch = { status: 409, code: "TEACHER_AMENDMENTS_MISMATCH" };
const openingMismatch = { status: 409, code: "ACTIVITY_BINDINGS_MISMATCH" };
const empty: ActivityBindingClaims = { protocolVersion: 1, bindings: [], openingIntents: [],
  teacherAmendments: { completed: [], pending: [] } };

function options(databasePath: string) {
  return { databasePath, authorizeChoiceDraftAmendment: () => true };
}

function begin(runtime: ReturnType<typeof openLearningRuntime>, actor: typeof student | typeof other) {
  const { activityId, stepAttemptId } = runtime.start(actor, open);
  const opening = { activityId, studentId: actor.id, operationId: open.operationId };
  const proof: TeacherAmendmentBinding = { kind: "answer", activityId, studentId: actor.id, stepAttemptId,
    slotId: "answers", questionId, reviewerId: teacher.id, operationId: "adjust", revision: 1 };
  return { opening, proof };
}

function withAmendments(claims: ActivityBindingClaims, completed: TeacherAmendmentBinding[], pending: TeacherAmendmentBinding[] = []) {
  return { ...claims, teacherAmendments: { completed, pending } };
}

function amend(runtime: ReturnType<typeof openLearningRuntime>, proof: TeacherAmendmentBinding) {
  const { activityId, stepAttemptId, slotId, questionId, operationId } = proof;
  return runtime.amendChoiceDraft(teacher, activityId, { protocolVersion: 1, stepAttemptId, slotId, questionId,
    questionVersion: 1, baseRevision: proof.revision - 1, operationId, choice: "0", reason: "仅供审计的修正理由" });
}

test("备份勘误对账核精确操作、作者和归属，读取保留字节及原开卷校验", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime(options(path));
  let accepted;
  let scheduled;
  try {
    runtime.publish(publication);
    accepted = begin(runtime, student);
    scheduled = begin(runtime, other);
    assert.equal(amend(runtime, accepted.proof).revision, accepted.proof.revision);
  } finally {
    runtime.close();
  }
  const bindings = { ...empty, bindings: [accepted.opening, scheduled.opening] };
  const before = readFileSync(path);
  const compare = (completed: TeacherAmendmentBinding[], pending: TeacherAmendmentBinding[] = []) =>
    verifyActivityBindings(path, withAmendments(bindings, completed, pending));
  assert.equal(compare([accepted.proof], [scheduled.proof]), undefined);
  assert.equal(compare([], [accepted.proof, scheduled.proof]), undefined);
  assert.throws(() => compare([], [scheduled.proof]), mismatch);
  assert.throws(() => compare([accepted.proof, scheduled.proof]), mismatch);
  assert.throws(() => compare([accepted.proof], [{ ...accepted.proof, revision: 2 }]), mismatch);
  assert.throws(() => compare([accepted.proof], [scheduled.proof, scheduled.proof]), mismatch);
  assert.throws(() => compare([accepted.proof, accepted.proof]), mismatch);
  assert.throws(() => compare([{ ...accepted.proof, revision: 2 }]), mismatch);
  assert.throws(() => compare([accepted.proof], [{ ...scheduled.proof, questionId: "unknown" }]), mismatch);
  assert.throws(() => compare([accepted.proof], [{ ...scheduled.proof, slotId: "unknown" }]), mismatch);
  assert.throws(() => compare([accepted.proof], [{ ...scheduled.proof, activityId: accepted.proof.activityId }]), mismatch);
  assert.throws(() => verifyActivityBindings(path, { ...bindings, bindings: [accepted.opening] }), openingMismatch);
  const { teacherAmendments, ...previous } = bindings;
  assert.equal(verifyActivityBindings(path, previous), undefined);
  const unsolicited = { ...accepted.proof, reason: "private answer" };
  assert.throws(() => compare([unsolicited]), ZodError);
  assert.deepEqual(readFileSync(path), before);
});

test("空勘误声明需要完整迁移证据，历史缺表和当前缺表有各自结果", t => {
  const missing = scenarioDatabase(t);
  assert.throws(() => verifyActivityBindings(missing, empty));
  assert.equal(existsSync(missing), false);

  const current = scenarioDatabase(t);
  openLearningRuntime(options(current)).close();
  assert.equal(verifyActivityBindings(current, empty), undefined);
  using currentDatabase = new DatabaseSync(current);
  currentDatabase.exec("DROP TABLE choice_snapshot_revisions");
  const incomplete = readFileSync(current);
  assert.throws(() => verifyActivityBindings(current, empty), mismatch);
  assert.deepEqual(readFileSync(current), incomplete);

  currentDatabase.exec("DELETE FROM schema_migrations WHERE version = 15");
  const prior = readFileSync(current);
  assert.equal(verifyActivityBindings(current, empty), undefined);
  assert.deepEqual(readFileSync(current), prior);

  currentDatabase.exec("DELETE FROM schema_migrations WHERE version = 13");
  assert.throws(() => verifyActivityBindings(current, empty), mismatch);
  currentDatabase.exec("INSERT INTO schema_migrations (version) VALUES (13), (15), (16)");
  assert.throws(() => verifyActivityBindings(current, empty), mismatch);
  currentDatabase.exec("DROP TABLE schema_migrations");
  assert.throws(() => verifyActivityBindings(current, empty), mismatch);
});

test("历史答案勘误的真实作品修订在题面能力出现前仍能精确配对", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime(options(path));
  let owner;
  try {
    runtime.publish(publication);
    owner = begin(runtime, student);
    amend(runtime, owner.proof);
  } finally {
    runtime.close();
  }

  using database = new DatabaseSync(path);
  database.exec("DROP TABLE choice_snapshot_revisions; DELETE FROM schema_migrations WHERE version = 15");
  const original = { ...empty, bindings: [owner.opening] };
  const prior = readFileSync(path);
  assert.equal(verifyActivityBindings(path, withAmendments(original, [owner.proof])), undefined);
  assert.throws(() => verifyActivityBindings(path, original), mismatch);
  assert.deepEqual(readFileSync(path), prior);
  database.exec("DELETE FROM schema_migrations WHERE version = 14");
  assert.throws(() => verifyActivityBindings(path, original), mismatch);
  database.exec("DROP TABLE choice_draft_amendments");
  const older = readFileSync(path);
  assert.equal(verifyActivityBindings(path, original), undefined);
  assert.throws(() => verifyActivityBindings(path, withAmendments(original, [owner.proof])), mismatch);
  assert.equal(verifyActivityBindings(path, withAmendments(original, [], [owner.proof])), undefined);
  assert.deepEqual(readFileSync(path), older);
});
