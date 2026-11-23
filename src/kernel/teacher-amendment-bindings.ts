import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { teacherAmendmentBinding } from "../contracts/activity-bindings.ts";
import type { TeacherAmendmentBinding, TeacherAmendmentBindingClaims } from "../contracts/activity-bindings.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import { choiceSnapshotOffsetForWork } from "./choice-snapshot-store.ts";
import { latestDatabaseVersion } from "./database.ts";
import { LearningError } from "../contracts/learning-error.ts";

const ledger = z.strictObject({ first: z.literal(1), version: z.int().min(1).max(latestDatabaseVersion), count: z.int().positive() });
const publishedStep = z.strictObject({ definition: z.string(), stepId: z.string() });
type ExpectedAmendment = { binding: TeacherAmendmentBinding; completed: boolean };

function amendmentMismatch() {
  return new LearningError(409, "TEACHER_AMENDMENTS_MISMATCH");
}

export function verifyTeacherAmendmentBindings(database: DatabaseSync, claims: TeacherAmendmentBindingClaims) {
  const expected = claimAmendments(claims);
  const { answers, snapshots } = amendmentTables(database);
  if (answers) matchAmendments(expected, answerAmendments(database, snapshots));
  if (snapshots) matchAmendments(expected, snapshotAmendments(database));
  verifyPendingAmendments(database, expected.values());
}

function claimAmendments(claims: TeacherAmendmentBindingClaims) {
  const expected = new Map<string, ExpectedAmendment>();
  for (const binding of claims.completed) addClaim(expected, binding, true);
  for (const binding of claims.pending) addClaim(expected, binding, false);
  return expected;
}

function addClaim(expected: Map<string, ExpectedAmendment>, binding: TeacherAmendmentBinding, completed: boolean) {
  const key = amendmentKey(binding);
  if (expected.has(key)) throw amendmentMismatch();
  expected.set(key, { binding, completed });
}

function amendmentKey({ kind, activityId, studentId, stepAttemptId, slotId, questionId, reviewerId, operationId }: TeacherAmendmentBinding) {
  return JSON.stringify([kind, activityId, studentId, stepAttemptId, slotId, questionId, reviewerId, operationId]);
}

function amendmentTables(database: DatabaseSync) {
  const tables = new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name IN ('schema_migrations', 'choice_draft_amendments', 'choice_snapshot_revisions')
  `).all().map(row => row.name));
  if (!tables.has("schema_migrations")) throw amendmentMismatch();
  const versions = ledger.safeParse(database.prepare(`
    SELECT MIN(version) AS first, MAX(version) AS version, COUNT(DISTINCT version) AS count FROM schema_migrations
  `).get());
  if (!versions.success || versions.data.version !== versions.data.count) throw amendmentMismatch();
  const answers = versions.data.version >= 14;
  const snapshots = versions.data.version >= 15;
  if (answers !== tables.has("choice_draft_amendments") || snapshots !== tables.has("choice_snapshot_revisions")) {
    throw amendmentMismatch();
  }
  return { answers, snapshots };
}

function answerAmendments(database: DatabaseSync, snapshots: boolean) {
  const offset = snapshots ? choiceSnapshotOffsetForWork : "0";
  return database.prepare(`
    SELECT 'answer' AS kind, a.id AS activityId, a.student_id AS studentId, s.id AS stepAttemptId,
      w.slot_id AS slotId, w.question_id AS questionId, t.reviewer_id AS reviewerId, t.operation_id AS operationId,
      v.version + ${offset} AS revision
    FROM choice_draft_amendments t
    LEFT JOIN work_versions v ON v.work_id = t.work_id AND v.version = t.revision
    LEFT JOIN works w ON w.id = t.work_id
    LEFT JOIN step_attempts s ON s.id = w.step_attempt_id AND s.activity_id = w.activity_id
    LEFT JOIN activities a ON a.id = w.activity_id
  `).iterate();
}

function snapshotAmendments(database: DatabaseSync) {
  return database.prepare(`
    SELECT 'snapshot' AS kind, a.id AS activityId, a.student_id AS studentId, s.id AS stepAttemptId,
      r.slot_id AS slotId, r.question_id AS questionId, r.reviewer_id AS reviewerId, r.operation_id AS operationId, r.revision
    FROM choice_snapshot_revisions r
    LEFT JOIN step_attempts s ON s.id = r.step_attempt_id
    LEFT JOIN activities a ON a.id = s.activity_id
  `).iterate();
}

function matchAmendments(expected: Map<string, ExpectedAmendment>, rows: Iterable<unknown>) {
  for (const row of rows) {
    const parsed = teacherAmendmentBinding.safeParse(row);
    if (!parsed.success) throw amendmentMismatch();
    const key = amendmentKey(parsed.data);
    const match = expected.get(key);
    if (match?.binding.revision !== parsed.data.revision) throw amendmentMismatch();
    expected.delete(key);
  }
}

function verifyPendingAmendments(database: DatabaseSync, unmatched: Iterable<ExpectedAmendment>) {
  const stepForBinding = database.prepare(`
    SELECT p.definition, s.step_id AS stepId FROM step_attempts s
    JOIN activities a ON a.id = s.activity_id
    JOIN practices p ON p.id = a.practice_id AND p.version = a.practice_version
    WHERE s.id = ? AND a.id = ? AND a.student_id = ?
  `);
  for (const { binding, completed } of unmatched) {
    if (completed) throw amendmentMismatch();
    const stored = stepForBinding.get(binding.stepAttemptId, binding.activityId, binding.studentId);
    if (!isQuestionInStep(stored, binding)) throw amendmentMismatch();
  }
}

function isQuestionInStep(row: unknown, { slotId, questionId }: TeacherAmendmentBinding) {
  const stored = publishedStep.safeParse(row);
  if (!stored.success) return false;
  const practice = readingPracticeSchema.safeParse(JSON.parse(stored.data.definition));
  if (!practice.success) return false;
  const step = practice.data.steps.find(candidate => candidate.id === stored.data.stepId);
  const slot = step?.submit.slots[slotId];
  return slot?.type === "oneChoicePerQuestion" && step?.inputs[slot.source]?.from === "questions"
    && practice.data.questions.some(question => question.id === questionId);
}
