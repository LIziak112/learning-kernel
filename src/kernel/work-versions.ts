import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import { readIndexResponseConfirmation, readResponseConfirmation } from "../contracts/response.ts";
import { selectionSchema } from "../contracts/reading.ts";
import { readingAnswer, readingSelection } from "../contracts/reading-runtime.ts";
import { LearningError } from "./learning-error.ts";

const latestDraft = z.object({ latest: z.int() });

export type WorkScope = { activityId: string; step?: { id: string; slotId: string; questionId?: string } };

export function saveWorkVersion(database: DatabaseSync, scope: WorkScope, content: unknown, workId?: string) {
  const fresh = workId === undefined;
  const id = fresh ? randomUUID() : workId;
  const version = nextVersion(database, scope, id, fresh);
  database.prepare("INSERT INTO work_versions (work_id, version, selection) VALUES (?, ?, ?)")
    .run(id, version, JSON.stringify(content));
  return { id, version };
}

function nextVersion(database: DatabaseSync, scope: WorkScope, id: string, fresh: boolean) {
  if (fresh) {
    database.prepare("INSERT INTO works (id, activity_id, step_attempt_id, slot_id, question_id) VALUES (?, ?, ?, ?, ?)")
      .run(id, ...scopeValues(scope));
    return 1;
  }
  requireWorkScope(database, scope, id);
  const row = database.prepare("SELECT MAX(version) AS latest FROM work_versions WHERE work_id = ?").get(id);
  const { latest } = latestDraft.parse(row);
  return latest + 1;
}

export function loadWorkVersion(database: DatabaseSync, scope: WorkScope, draft: { id: string; version: number }): unknown {
  requireWorkScope(database, scope, draft.id);
  const row = database.prepare("SELECT selection FROM work_versions WHERE work_id = ? AND version = ?")
    .get(draft.id, draft.version);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  return JSON.parse(String(row.selection));
}

export function readPersonalDraft(database: DatabaseSync, student: string, workId: string) {
  const row = database.prepare(`
    SELECT v.version, v.selection FROM works w
    JOIN activities a ON a.id = w.activity_id JOIN work_versions v ON v.work_id = w.id
    WHERE w.id = ? AND a.student_id = ? AND w.question_id IS NULL ORDER BY v.version DESC LIMIT 1
  `).get(workId, student);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  const stored = z.object({ version: z.int().positive(), selection: z.string() }).parse(row);
  const content: unknown = JSON.parse(stored.selection);
  if (readChoiceConfirmation(content) || readResponseConfirmation(content) || readIndexResponseConfirmation(content)) {
    throw new LearningError(403, "FORBIDDEN");
  }
  return { draft: { id: workId, version: stored.version }, content: authorInput(content) };
}

function authorInput(content: unknown) {
  const multiple = readingSelection.safeParse(content);
  if (multiple.success) return { ranges: multiple.data.ranges.map(item => ({ role: item.role, ...item.range })) };
  const answer = readingAnswer.safeParse(content);
  if (answer.success) return { choices: answer.data.choices, reason: answer.data.reason };
  return { range: selectionSchema.parse(content).range };
}

function requireWorkScope(database: DatabaseSync, scope: WorkScope, id: string) {
  const work = database.prepare(`
    SELECT 1 FROM works WHERE id = ? AND activity_id = ? AND step_attempt_id IS ? AND slot_id IS ? AND question_id IS ?
  `).get(id, ...scopeValues(scope));
  if (!work) throw new LearningError(403, "FORBIDDEN");
}

function scopeValues({ activityId, step }: WorkScope) {
  return [activityId, step?.id ?? null, step?.slotId ?? null, step?.questionId ?? null];
}
