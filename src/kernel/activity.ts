import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { materialSchema, practiceSchema, startReceipt } from "../contracts/reading.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import type { StartInput } from "../contracts/reading.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const storedStart = startReceipt.extend({ practiceId: z.string(), practiceVersion: z.int(), prepared: z.literal([0, 1]), redoOf: z.uuid().nullable() });
const storedActivity = startReceipt.extend({
  stepId: z.string(),
  materialJSON: z.string().nullable(),
  practiceJSON: z.string(),
  preparedPracticeVersion: z.int().positive().nullable(),
  completed: z.literal([0, 1]),
  redoOf: z.uuid().nullable(),
});
const publishedPractice = z.union([practiceSchema, readingPracticeSchema]);

export type ReadingActivity = Extract<ReturnType<typeof loadActivity>, { kind: "reading" }>;

type OpeningInput = StartInput & { practiceVersion?: number };
type OpeningMode = "start" | "prepare";

export function startActivity(
  database: DatabaseSync, student: string, input: OpeningInput, clock: () => Date, assignedReviewer?: string,
  openingMode: OpeningMode = "start",
) {
  return writeTransaction(database, () => {
    const { practiceId, practiceVersion, operationId } = input;
    const existing = recoverStart(database, student, operationId);
    if (existing) return recoverOpening(existing, input, openingMode);

    const published = database.prepare(`
      SELECT definition FROM practices WHERE id = ? AND version = COALESCE(?, version) ORDER BY version DESC LIMIT 1
    `).get(practiceId, practiceVersion ?? null);
    if (!published) throw new LearningError(404, "PRACTICE_NOT_FOUND");
    const practice = publishedPractice.parse(JSON.parse(String(published.definition)));
    const prepared = openingMode === "prepare";
    if (prepared && !("formatVersion" in practice)) throw new LearningError(422, "ACTIVITY_NOT_PREPARABLE");
    return createActivity(database, student, practice, operationId, clock(), assignedReviewer, null, prepared);
  });
}

function recoverOpening(existing: NonNullable<ReturnType<typeof recoverStart>>, input: OpeningInput, mode: OpeningMode) {
  if (existing.practiceId !== input.practiceId || existing.redoOf || (mode === "prepare" && !existing.prepared)
    || (input.practiceVersion !== undefined && input.practiceVersion !== existing.practiceVersion)) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return existing.receipt;
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
    SELECT a.id AS activityId, COALESCE(a.initial_prepared_step_attempt_id, s.id) AS stepAttemptId,
      a.started_at AS startedAt, a.practice_id AS practiceId,
      COALESCE(a.initial_prepared_practice_version, a.practice_version) AS practiceVersion, a.redo_of AS redoOf,
      a.initial_prepared_step_attempt_id IS NOT NULL AS prepared
    FROM activities a JOIN step_attempts s ON s.activity_id = a.id
    WHERE a.student_id = ? AND a.start_operation_id = ? ORDER BY s.ordinal LIMIT 1
  `).get(student, operationId);
  if (!row) return undefined;
  const { practiceId, practiceVersion, redoOf, prepared, ...receipt } = storedStart.parse(row);
  requireStudentRecord(database, receipt.activityId);
  return { practiceId, practiceVersion, redoOf, prepared, receipt };
}

function createActivity(
  database: DatabaseSync, student: string, practice: z.infer<typeof publishedPractice>, operationId: string,
  startedAt: Date, assignedReviewer?: string, redoOf: string | null = null, prepared = false,
) {
  const receipt = { activityId: randomUUID(), stepAttemptId: randomUUID(), startedAt: startedAt.toISOString() };
  database.prepare(`
    INSERT INTO activities (id, student_id, practice_id, practice_version, start_operation_id, started_at, redo_of,
      initial_prepared_practice_version, initial_prepared_step_attempt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(receipt.activityId, student, practice.id, practice.version, operationId, receipt.startedAt, redoOf,
    prepared ? practice.version : null, prepared ? receipt.stepAttemptId : null);
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

export function loadStudentReadingActivity(database: DatabaseSync, student: string, activityId: string, stepAttemptId: string) {
  const activity = loadStudentActivity(database, student, activityId);
  if (activity.kind !== "reading" || activity.stepAttemptId !== stepAttemptId) throw new LearningError(403, "FORBIDDEN");
  return activity;
}

export function loadActivity(database: DatabaseSync, student: string, activityId: string) {
  const row = database.prepare(`
    SELECT a.id AS activityId, s.id AS stepAttemptId, s.step_id AS stepId, a.started_at AS startedAt,
      p.definition AS practiceJSON, m.definition AS materialJSON, a.redo_of AS redoOf,
      CASE WHEN a.initial_prepared_step_attempt_id IS NOT NULL THEN a.practice_version END AS preparedPracticeVersion,
      EXISTS (SELECT 1 FROM completions c WHERE c.activity_id = a.id) AS completed
    FROM activities a
    JOIN step_attempts s ON s.activity_id = a.id
    JOIN practices p ON p.id = a.practice_id AND p.version = a.practice_version
    LEFT JOIN materials m ON m.id = p.material_id AND m.version = p.material_version
    WHERE a.id = ? AND a.student_id = ? ORDER BY s.ordinal DESC LIMIT 1
  `).get(activityId, student);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  const { stepId, materialJSON, practiceJSON, completed, redoOf, preparedPracticeVersion, ...receipt } = storedActivity.parse(row);
  const practice = publishedPractice.parse(JSON.parse(practiceJSON));
  const common = { ...receipt, completed: completed === 1 };
  if ("formatVersion" in practice) {
    const step = practice.steps.find(step => step.id === stepId);
    if (!step) throw new Error("活动的步骤尝试找不到已发布步骤");
    const material = practice.material ? parseFrozenMaterial(materialJSON) : undefined;
    return { kind: "reading" as const, ...common, material, practice, step, redoOf: redoOf ?? undefined,
      practiceVersion: preparedPracticeVersion ?? undefined };
  }
  return { kind: "single" as const, ...common, material: parseFrozenMaterial(materialJSON), title: practice.title, step: practice.steps[0] };
}

function parseFrozenMaterial(definition: string | null) {
  if (definition === null) throw new Error("活动引用的已发布材料不存在");
  return materialSchema.parse(JSON.parse(definition));
}
