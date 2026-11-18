import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { materialSchema, practiceSchema, startReceipt } from "../contracts/reading.ts";
import type { StartInput } from "../contracts/reading.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const storedStart = startReceipt.extend({ practiceId: z.string() });
const storedActivity = startReceipt.extend({
  materialJSON: z.string(),
  practiceJSON: z.string(),
  completed: z.literal([0, 1]),
});

export function startActivity(database: DatabaseSync, student: string, input: StartInput) {
  return writeTransaction(database, () => {
    const existing = database.prepare(`
      SELECT a.id AS activityId, s.id AS stepAttemptId, a.started_at AS startedAt, a.practice_id AS practiceId
      FROM activities a JOIN step_attempts s ON s.activity_id = a.id
      WHERE a.student_id = ? AND a.start_operation_id = ?
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
    const practice = practiceSchema.parse(JSON.parse(String(published.definition)));
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
    SELECT a.id AS activityId, s.id AS stepAttemptId, a.started_at AS startedAt,
      p.definition AS practiceJSON, m.definition AS materialJSON,
      EXISTS (SELECT 1 FROM completions c WHERE c.activity_id = a.id) AS completed
    FROM activities a
    JOIN step_attempts s ON s.activity_id = a.id
    JOIN practices p ON p.id = a.practice_id AND p.version = a.practice_version
    JOIN materials m ON m.id = p.material_id AND m.version = p.material_version
    WHERE a.id = ? AND a.student_id = ?
  `).get(activityId, student);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  const { materialJSON, practiceJSON, completed, ...receipt } = storedActivity.parse(row);
  const practice = practiceSchema.parse(JSON.parse(practiceJSON));
  return {
    ...receipt,
    title: practice.title,
    material: materialSchema.parse(JSON.parse(materialJSON)),
    step: practice.steps[0],
    completed: completed === 1,
  };
}
