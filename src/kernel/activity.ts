import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { materialSchema, practiceSchema, startReceipt } from "../contracts/reading.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import type { StartInput } from "../contracts/reading.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const storedStart = startReceipt.extend({ practiceId: z.string() });
const storedActivity = startReceipt.extend({
  stepId: z.string(),
  materialJSON: z.string(),
  practiceJSON: z.string(),
  completed: z.literal([0, 1]),
});
const publishedPractice = z.union([practiceSchema, readingPracticeSchema]);

export type ReadingActivity = Extract<ReturnType<typeof loadActivity>, { kind: "reading" }>;

export function startActivity(database: DatabaseSync, student: string, input: StartInput) {
  return writeTransaction(database, () => {
    const existing = database.prepare(`
      SELECT a.id AS activityId, s.id AS stepAttemptId, a.started_at AS startedAt, a.practice_id AS practiceId
      FROM activities a JOIN step_attempts s ON s.activity_id = a.id
      WHERE a.student_id = ? AND a.start_operation_id = ? ORDER BY s.ordinal LIMIT 1
    `).get(student, input.operationId);
    if (existing) {
      const { practiceId, ...receipt } = storedStart.parse(existing);
      if (practiceId !== input.practiceId) throw new LearningError(409, "OPERATION_CONFLICT");
      return receipt;
    }

    const published = database.prepare(`
      SELECT definition FROM practices WHERE id = ? ORDER BY version DESC LIMIT 1
    `).get(input.practiceId);
    if (!published) throw new LearningError(404, "PRACTICE_NOT_FOUND");
    const practice = publishedPractice.parse(JSON.parse(String(published.definition)));
    const receipt = { activityId: randomUUID(), stepAttemptId: randomUUID(), startedAt: new Date().toISOString() };
    database.prepare(`
      INSERT INTO activities (id, student_id, practice_id, practice_version, start_operation_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receipt.activityId, student, practice.id, practice.version, input.operationId, receipt.startedAt);
    database.prepare("INSERT INTO step_attempts (id, activity_id, step_id) VALUES (?, ?, ?)")
      .run(receipt.stepAttemptId, receipt.activityId, practice.steps[0].id);
    return receipt;
  });
}

export function loadActivity(database: DatabaseSync, student: string, activityId: string) {
  const row = database.prepare(`
    SELECT a.id AS activityId, s.id AS stepAttemptId, s.step_id AS stepId, a.started_at AS startedAt,
      p.definition AS practiceJSON, m.definition AS materialJSON,
      EXISTS (SELECT 1 FROM completions c WHERE c.activity_id = a.id) AS completed
    FROM activities a
    JOIN step_attempts s ON s.activity_id = a.id
    JOIN practices p ON p.id = a.practice_id AND p.version = a.practice_version
    JOIN materials m ON m.id = p.material_id AND m.version = p.material_version
    WHERE a.id = ? AND a.student_id = ? ORDER BY s.ordinal DESC LIMIT 1
  `).get(activityId, student);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  const { stepId, materialJSON, practiceJSON, completed, ...receipt } = storedActivity.parse(row);
  const practice = publishedPractice.parse(JSON.parse(practiceJSON));
  const common = { ...receipt, material: materialSchema.parse(JSON.parse(materialJSON)), completed: completed === 1 };
  if ("formatVersion" in practice) {
    const step = practice.steps.find(step => step.id === stepId);
    if (!step) throw new Error("活动的步骤尝试找不到已发布步骤");
    return { kind: "reading" as const, ...common, practice, step };
  }
  return { kind: "single" as const, ...common, title: practice.title, step: practice.steps[0] };
}
