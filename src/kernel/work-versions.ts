import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { LearningError } from "./learning-error.ts";

const latestDraft = z.object({ latest: z.int() });

export type WorkScope = { activityId: string; step?: { id: string; slotId: string } };

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
    database.prepare("INSERT INTO works (id, activity_id, step_attempt_id, slot_id) VALUES (?, ?, ?, ?)")
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

function requireWorkScope(database: DatabaseSync, scope: WorkScope, id: string) {
  const work = database.prepare(`
    SELECT 1 FROM works WHERE id = ? AND activity_id = ? AND step_attempt_id IS ? AND slot_id IS ?
  `).get(id, ...scopeValues(scope));
  if (!work) throw new LearningError(403, "FORBIDDEN");
}

function scopeValues({ activityId, step }: WorkScope) {
  return step ? [activityId, step.id, step.slotId] : [activityId, null, null];
}
