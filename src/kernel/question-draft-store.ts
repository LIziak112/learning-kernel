import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChoiceDraftInput, ChoiceDraftScope } from "../contracts/choice-draft.ts";
import type { StoredResponseValue } from "../contracts/response.ts";
import { choiceSnapshotOffsetForWork } from "./choice-snapshot-store.ts";
import { LearningError } from "./learning-error.ts";

type DraftValue = Pick<ChoiceDraftInput, "questionVersion" | "choice"> | { questionVersion: number; value: StoredResponseValue };

export class QuestionDraftConflict<Current extends { revision: number }> extends LearningError {
  readonly current: Readonly<Current>;

  constructor(current: Readonly<Current>, code: "ANSWER_REVISION_CONFLICT" | "OPERATION_CONFLICT" = "ANSWER_REVISION_CONFLICT") {
    super(409, code);
    this.current = current;
  }
}

const storedVersion = z.object({
  workId: z.uuid(), slotId: z.string(), questionId: z.string(), workVersion: z.int().positive(),
  revision: z.int().positive(), changeCount: z.int().nonnegative(), content: z.string(),
});
const storedOperation = storedVersion.extend({ baseRevision: z.int().nonnegative() });
const versionColumns = `
  w.id AS workId, w.slot_id AS slotId, w.question_id AS questionId, v.version AS workVersion, v.selection AS content,
  v.version + ${choiceSnapshotOffsetForWork} AS revision,
  v.version - (SELECT COUNT(*) FROM choice_draft_amendments a WHERE a.work_id = w.id AND a.revision <= v.version) AS changeCount
`;
const currentDrafts = `
  SELECT ${versionColumns}
  FROM works w JOIN work_versions v ON v.work_id = w.id
    AND v.version = (SELECT MAX(version) FROM work_versions WHERE work_id = w.id)
  WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.question_id IS NOT NULL
`;

function decodeDraft<T extends DraftValue>({ content, ...version }: z.infer<typeof storedVersion>, value: z.ZodType<T>) {
  return { ...version, ...value.parse(JSON.parse(content)) };
}

export function publicDraft<T extends { workId: string; workVersion: number }>({ workId, workVersion, ...draft }: T) {
  return draft;
}

export function readQuestionDrafts<T extends DraftValue>(
  database: DatabaseSync, activityId: string, stepAttemptId: string, schema: z.ZodType<T>,
) {
  return database.prepare(currentDrafts + "ORDER BY w.slot_id, w.question_id").all(activityId, stepAttemptId)
    .map(row => publicDraft(decodeDraft(storedVersion.parse(row), schema)));
}

export function readQuestionDraftHead<T extends DraftValue>(
  database: DatabaseSync, activityId: string, { stepAttemptId, slotId, questionId }: ChoiceDraftScope, schema: z.ZodType<T>,
) {
  const row = database.prepare(currentDrafts + "AND w.slot_id = ? AND w.question_id = ?")
    .get(activityId, stepAttemptId, slotId, questionId);
  return row && decodeDraft(storedVersion.parse(row), schema);
}

export function readQuestionDraftRevision<T extends DraftValue>(
  database: DatabaseSync, workId: string, revision: number, schema: z.ZodType<T>,
) {
  const row = database.prepare(`
    SELECT ${versionColumns} FROM works w JOIN work_versions v ON v.work_id = w.id
    WHERE w.id = ? AND v.version = ?
  `).get(workId, revision);
  return decodeDraft(storedVersion.parse(row), schema);
}

type VersionedDraftScope = ChoiceDraftScope & Pick<ChoiceDraftInput, "operationId" | "baseRevision">;
export function readQuestionDraftOperation<T extends DraftValue>(
  database: DatabaseSync, activityId: string, scope: VersionedDraftScope, schema: z.ZodType<T>,
) {
  const row = database.prepare(`
    SELECT ${versionColumns}, o.base_revision AS baseRevision
    FROM choice_draft_operations o
    JOIN works w ON w.id = o.work_id
    JOIN work_versions v ON v.work_id = o.work_id AND v.version = o.revision
    WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.slot_id = ? AND w.question_id = ? AND o.operation_id = ?
  `).get(activityId, scope.stepAttemptId, scope.slotId, scope.questionId, scope.operationId);
  if (!row) return undefined;
  const { baseRevision, ...stored } = storedOperation.parse(row);
  return { baseRevision, draft: decodeDraft(stored, schema) };
}

export function isLatestQuestionDraftOperation(database: DatabaseSync, workId: string, operationId: string) {
  return Boolean(database.prepare(`
    SELECT 1 FROM choice_draft_latest_operations WHERE work_id = ? AND operation_id = ?
  `).get(workId, operationId));
}

export function rememberQuestionDraftOperation(
  database: DatabaseSync, input: VersionedDraftScope, { workId, workVersion }: { workId: string; workVersion: number },
) {
  database.prepare(`
    INSERT INTO choice_draft_operations (work_id, operation_id, base_revision, revision)
    VALUES (?, ?, ?, ?) ON CONFLICT (work_id, operation_id) DO NOTHING
  `).run(workId, input.operationId, input.baseRevision, workVersion);
  database.prepare(`
    INSERT INTO choice_draft_latest_operations (work_id, operation_id) VALUES (?, ?)
    ON CONFLICT (work_id) DO UPDATE SET operation_id = excluded.operation_id
  `).run(workId, input.operationId);
}
