import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { submissionReceipt } from "../contracts/reading.ts";
import type { SubmitInput } from "../contracts/reading.ts";
import { LearningError } from "./learning-error.ts";

export function recoverReceipt(database: DatabaseSync, input: SubmitInput) {
  const row = database.prepare(`
    SELECT id, step_attempt_id AS stepAttemptId, slot_id AS slotId, confirmed_at AS confirmedAt,
      work_id AS workId, work_version AS workVersion
    FROM submissions WHERE step_attempt_id = ? AND operation_id = ?
  `).get(input.stepAttemptId, input.operationId);
  if (!row) return undefined;
  const { workId, workVersion, ...receipt } = row;
  if (receipt.slotId !== input.slotId || workId !== input.draft.id || workVersion !== input.draft.version) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return submissionReceipt.parse(receipt);
}

export function recordSubmission(database: DatabaseSync, input: SubmitInput, targetId: string) {
  const receipt = {
    id: randomUUID(),
    stepAttemptId: input.stepAttemptId,
    slotId: input.slotId,
    confirmedAt: new Date().toISOString(),
  };
  database.prepare(`
    INSERT INTO submissions (id, step_attempt_id, slot_id, operation_id, work_id, work_version, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(receipt.id, receipt.stepAttemptId, receipt.slotId, input.operationId,
    input.draft.id, input.draft.version, receipt.confirmedAt);
  database.prepare("INSERT INTO performances (id, submission_id, target_id) VALUES (?, ?, ?)")
    .run(randomUUID(), receipt.id, targetId);
  return receipt;
}

export function finishActivity(database: DatabaseSync, activityId: string, submissionId: string) {
  database.prepare("INSERT INTO completions (activity_id, submission_id) VALUES (?, ?)").run(activityId, submissionId);
}

export function activitySubmissions(database: DatabaseSync, activityId: string) {
  return database.prepare(`
    SELECT s.id, s.step_attempt_id AS stepAttemptId, s.slot_id AS slotId, s.confirmed_at AS confirmedAt,
      a.step_id AS stepId, v.selection
    FROM submissions s
    JOIN step_attempts a ON a.id = s.step_attempt_id
    JOIN work_versions v ON v.work_id = s.work_id AND v.version = s.work_version
    WHERE a.activity_id = ? ORDER BY a.ordinal, s.confirmed_at, s.id
  `).all(activityId).map(({ stepId, selection, ...receipt }) => ({
    stepId: String(stepId),
    receipt: submissionReceipt.parse(receipt),
    content: JSON.parse(String(selection)) as unknown,
  }));
}

export type StoredSubmission = ReturnType<typeof activitySubmissions>[number];
