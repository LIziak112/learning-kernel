import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { draftReceipt, selectionSchema, submissionReceipt } from "../contracts/reading.ts";
import type { ActivityDetail, SaveInput, SubmissionDetail, SubmitInput } from "../contracts/reading.ts";
import { selectText } from "../builtins/selection.ts";
import { loadActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const latestDraft = z.object({ latest: z.int().nullable() });

export function saveDraft(database: DatabaseSync, student: string, activityId: string, input: SaveInput) {
  return writeTransaction(database, () => {
    const activity = loadActivity(database, student, activityId);
    const selection = selectText(activity.material, activity.step, input.range);
    const { id, version } = nextDraft(database, activityId, input.workId);
    database.prepare("INSERT INTO work_versions (work_id, version, selection) VALUES (?, ?, ?)")
      .run(id, version, JSON.stringify(selection));
    return draftReceipt.parse({ draft: { id, version }, selection });
  });
}

function nextDraft(database: DatabaseSync, activityId: string, id?: string) {
  if (id === undefined) {
    const id = randomUUID();
    database.prepare("INSERT INTO works (id, activity_id) VALUES (?, ?)").run(id, activityId);
    return { id, version: 1 };
  }
  const { latest } = latestDraft.parse(database.prepare(`
    SELECT MAX(v.version) AS latest FROM work_versions v JOIN works w ON w.id = v.work_id
    WHERE w.id = ? AND w.activity_id = ?
  `).get(id, activityId));
  if (latest === null) throw new LearningError(403, "FORBIDDEN");
  return { id, version: latest + 1 };
}

export function submitDraft(database: DatabaseSync, student: string, activityId: string, input: SubmitInput) {
  return writeTransaction(database, () => {
    const activity = loadActivity(database, student, activityId);
    if (activity.stepAttemptId !== input.stepAttemptId) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const repeated = recoverReceipt(database, input);
    if (repeated) return repeated;

    if (input.slotId !== activity.step.slotId) throw new LearningError(422, "INVALID_SLOT");
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");

    const draft = database.prepare(`
      SELECT 1 FROM work_versions v JOIN works w ON w.id = v.work_id
      WHERE w.id = ? AND v.version = ? AND w.activity_id = ?
    `).get(input.draft.id, input.draft.version, activityId);
    if (!draft) throw new LearningError(403, "FORBIDDEN");

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
      .run(randomUUID(), receipt.id, activity.step.targetId);
    database.prepare("INSERT INTO completions (activity_id, submission_id) VALUES (?, ?)")
      .run(activityId, receipt.id);
    return receipt;
  });
}

function recoverReceipt(database: DatabaseSync, input: SubmitInput) {
  const row = database.prepare(`
    SELECT id, step_attempt_id AS stepAttemptId, slot_id AS slotId, confirmed_at AS confirmedAt,
      work_id AS workId, work_version AS workVersion
    FROM submissions WHERE step_attempt_id = ? AND operation_id = ?
  `).get(input.stepAttemptId, input.operationId);
  if (!row) return;
  const { workId, workVersion, ...receipt } = row;
  if (receipt.slotId !== input.slotId || workId !== input.draft.id || workVersion !== input.draft.version) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return submissionReceipt.parse(receipt);
}

export function readActivity(database: DatabaseSync, student: string, activityId: string): ActivityDetail {
  const { completed, ...activity } = loadActivity(database, student, activityId);
  return {
    ...activity,
    status: completed ? "completed" : "active",
    submission: findSubmission(database, activity.stepAttemptId, activity.step.slotId),
  };
}

export function readSubmission(database: DatabaseSync, student: string, activityId: string, submissionId: string) {
  const activity = loadActivity(database, student, activityId);
  const result = findSubmission(database, activity.stepAttemptId, activity.step.slotId);
  if (result?.receipt.id !== submissionId) throw new LearningError(403, "FORBIDDEN");
  return result;
}

function findSubmission(database: DatabaseSync, stepAttemptId: string, slotId: string): SubmissionDetail | null {
  const row = database.prepare(`
    SELECT s.id, s.step_attempt_id AS stepAttemptId, s.slot_id AS slotId, s.confirmed_at AS confirmedAt, v.selection
    FROM submissions s JOIN work_versions v ON v.work_id = s.work_id AND v.version = s.work_version
    WHERE s.step_attempt_id = ? AND s.slot_id = ?
  `).get(stepAttemptId, slotId);
  if (!row) return null;
  const { selection, ...receipt } = row;
  return {
    receipt: submissionReceipt.parse(receipt),
    selection: selectionSchema.parse(JSON.parse(String(selection))),
  };
}
