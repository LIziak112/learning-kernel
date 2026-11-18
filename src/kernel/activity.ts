import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { materialSchema, practiceSchema, startReceipt } from "../contracts/reading.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import type { StartInput } from "../contracts/reading.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const storedStart = startReceipt.extend({ practiceId: z.string(), redoOf: z.uuid().nullable() });
const storedActivity = startReceipt.extend({
  stepId: z.string(),
  materialJSON: z.string(),
  practiceJSON: z.string(),
  completed: z.literal([0, 1]),
  redoOf: z.uuid().nullable(),
});
const publishedPractice = z.union([practiceSchema, readingPracticeSchema]);

export type ReadingActivity = Extract<ReturnType<typeof loadActivity>, { kind: "reading" }>;

export function startActivity(
  database: DatabaseSync, student: string, input: StartInput, clock: () => Date, assignedReviewer?: string,
) {
  return writeTransaction(database, () => {
    const existing = recoverStart(database, student, input.operationId);
    if (existing) {
      if (existing.practiceId !== input.practiceId || existing.redoOf) throw new LearningError(409, "OPERATION_CONFLICT");
      return existing.receipt;
    }

    const published = database.prepare(`
      SELECT definition FROM practices WHERE id = ? ORDER BY version DESC LIMIT 1
    `).get(input.practiceId);
    if (!published) throw new LearningError(404, "PRACTICE_NOT_FOUND");
    const practice = publishedPractice.parse(JSON.parse(String(published.definition)));
    return createActivity(database, student, practice, input.operationId, clock(), assignedReviewer);
  });
}

export function redoActivity(database: DatabaseSync, student: string, sourceId: string, operationId: string, clock: () => Date) {
  return writeTransaction(database, () => {
    const source = loadStudentActivity(database, student, sourceId);
    if (source.kind !== "reading") throw new LearningError(403, "FORBIDDEN");
    const existing = recoverStart(database, student, operationId);
    if (existing) {
      if (existing.redoOf !== sourceId) throw new LearningError(409, "OPERATION_CONFLICT");
      return existing.receipt;
    }
    const approval = database.prepare(`
      UPDATE reading_reviews SET redo_authorized = 0
      WHERE activity_id = ? AND redo_authorized = 1 AND student_active = 1 RETURNING reviewer_id
    `).get(sourceId);
    if (!source.completed || !approval) throw new LearningError(409, "REDO_NOT_AVAILABLE");
    return createActivity(database, student, source.practice, operationId, clock(), z.string().parse(approval.reviewer_id), sourceId);
  });
}

function recoverStart(database: DatabaseSync, student: string, operationId: string) {
  const row = database.prepare(`
    SELECT a.id AS activityId, s.id AS stepAttemptId, a.started_at AS startedAt, a.practice_id AS practiceId, a.redo_of AS redoOf
    FROM activities a JOIN step_attempts s ON s.activity_id = a.id
    WHERE a.student_id = ? AND a.start_operation_id = ? ORDER BY s.ordinal LIMIT 1
  `).get(student, operationId);
  if (!row) return undefined;
  const { practiceId, redoOf, ...receipt } = storedStart.parse(row);
  requireStudentRecord(database, receipt.activityId);
  return { practiceId, redoOf, receipt };
}

function createActivity(
  database: DatabaseSync, student: string, practice: z.infer<typeof publishedPractice>, operationId: string,
  startedAt: Date, assignedReviewer?: string, redoOf: string | null = null,
) {
  const receipt = { activityId: randomUUID(), stepAttemptId: randomUUID(), startedAt: startedAt.toISOString() };
  database.prepare(`
    INSERT INTO activities (id, student_id, practice_id, practice_version, start_operation_id, started_at, redo_of)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(receipt.activityId, student, practice.id, practice.version, operationId, receipt.startedAt, redoOf);
  database.prepare("INSERT INTO step_attempts (id, activity_id, step_id) VALUES (?, ?, ?)")
    .run(receipt.stepAttemptId, receipt.activityId, practice.steps[0].id);
  if ("formatVersion" in practice && assignedReviewer) {
    database.prepare("INSERT INTO reading_reviews (activity_id, reviewer_id) VALUES (?, ?)")
      .run(receipt.activityId, assignedReviewer);
  }
  return receipt;
}

function requireStudentRecord(database: DatabaseSync, activityId: string) {
  const revoked = database.prepare("SELECT 1 FROM reading_reviews WHERE activity_id = ? AND student_active = 0").get(activityId);
  if (revoked) throw new LearningError(403, "FORBIDDEN");
}

export function loadStudentActivity(database: DatabaseSync, student: string, activityId: string) {
  requireStudentRecord(database, activityId);
  return loadActivity(database, student, activityId);
}

export function loadActivity(database: DatabaseSync, student: string, activityId: string) {
  const row = database.prepare(`
    SELECT a.id AS activityId, s.id AS stepAttemptId, s.step_id AS stepId, a.started_at AS startedAt,
      p.definition AS practiceJSON, m.definition AS materialJSON, a.redo_of AS redoOf,
      EXISTS (SELECT 1 FROM completions c WHERE c.activity_id = a.id) AS completed
    FROM activities a
    JOIN step_attempts s ON s.activity_id = a.id
    JOIN practices p ON p.id = a.practice_id AND p.version = a.practice_version
    JOIN materials m ON m.id = p.material_id AND m.version = p.material_version
    WHERE a.id = ? AND a.student_id = ? ORDER BY s.ordinal DESC LIMIT 1
  `).get(activityId, student);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  const { stepId, materialJSON, practiceJSON, completed, redoOf, ...receipt } = storedActivity.parse(row);
  const practice = publishedPractice.parse(JSON.parse(practiceJSON));
  const common = { ...receipt, material: materialSchema.parse(JSON.parse(materialJSON)), completed: completed === 1 };
  if ("formatVersion" in practice) {
    const step = practice.steps.find(step => step.id === stepId);
    if (!step) throw new Error("活动的步骤尝试找不到已发布步骤");
    return { kind: "reading" as const, ...common, practice, step, redoOf: redoOf ?? undefined };
  }
  return { kind: "single" as const, ...common, title: practice.title, step: practice.steps[0] };
}
