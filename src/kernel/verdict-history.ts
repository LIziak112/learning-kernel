import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { verdictReceipt } from "../contracts/verdict.ts";
import type { VerdictCommand, VerdictLocation } from "../contracts/verdict.ts";
import { LearningError } from "./learning-error.ts";

const storedEvent = verdictReceipt.extend({
  reviewerId: z.string(),
  reason: z.string(),
  reviewedAt: z.iso.datetime(),
  action: z.enum(["override", "withdraw"]),
  correct: z.literal([0, 1]).nullable(),
  withdrawId: z.uuid().nullable(),
});

const eventFields = `
  id, submission_id AS submissionId, target_id AS targetId, question_id AS questionId, revision,
  reviewer_id AS reviewerId, reason, reviewed_at AS reviewedAt, action, correct, withdraw_id AS withdrawId
`;

type Event = z.infer<typeof storedEvent>;

export function verdictHistory(database: DatabaseSync, assessment: Pick<VerdictLocation, "submissionId" | "targetId">) {
  return database.prepare(`
    SELECT ${eventFields} FROM verdict_events
    WHERE submission_id = ? AND target_id = ? ORDER BY revision
  `).all(assessment.submissionId, assessment.targetId).map(row => storedEvent.parse(row));
}

export function activeTeacherVerdict(history: Event[]) {
  const withdrawn = new Set(history.map(entry => entry.withdrawId));
  const active = history.findLast(entry => entry.correct !== null && !withdrawn.has(entry.id));
  if (!active) return undefined;
  return { source: "teacherReview" as const, id: active.id, correct: Boolean(active.correct) };
}

export function eventView(event: Event) {
  const { correct, withdrawId, ...fields } = event;
  return {
    ...fields, correct: correct === null ? undefined : Boolean(correct), withdrawId: withdrawId ?? undefined,
  };
}

function commandVerdict(command: VerdictCommand) {
  return command.action === "override"
    ? { correct: Number(command.correct), withdrawId: null }
    : { correct: null, withdrawId: command.withdrawId };
}

export function repeatedReview(database: DatabaseSync, activityId: string, reviewer: string, command: VerdictCommand) {
  const row = database.prepare(`
    SELECT ${eventFields} FROM verdict_events WHERE activity_id = ? AND reviewer_id = ? AND operation_id = ?
  `).get(activityId, reviewer, command.operationId);
  if (!row) return undefined;
  const event = storedEvent.parse(row);
  const outcome = commandVerdict(command);
  const previous = [
    event.submissionId, event.targetId, event.questionId, event.revision - 1, event.reason, event.action, event.correct, event.withdrawId,
  ];
  const requested = [
    command.submissionId, command.targetId, command.questionId, command.expectedRevision,
    command.reason, command.action, outcome.correct, outcome.withdrawId,
  ];
  if (JSON.stringify(previous) !== JSON.stringify(requested)) throw new LearningError(409, "OPERATION_CONFLICT");
  return reviewReceipt(event);
}

export function appendReview(
  database: DatabaseSync, activityId: string, reviewer: string, command: VerdictCommand, clock: () => Date,
) {
  const history = verdictHistory(database, command).filter(event => event.questionId === command.questionId);
  const revision = history.at(-1)?.revision ?? 0;
  if (revision !== command.expectedRevision) throw new LearningError(409, "VERDICT_CONFLICT");
  if (command.action === "withdraw" && activeTeacherVerdict(history)?.id !== command.withdrawId) {
    throw new LearningError(409, "VERDICT_CONFLICT");
  }
  const { correct, withdrawId } = commandVerdict(command);
  const receipt = {
    id: randomUUID(), submissionId: command.submissionId, targetId: command.targetId,
    questionId: command.questionId, revision: revision + 1,
  };
  database.prepare(`
    INSERT INTO verdict_events (id, activity_id, submission_id, target_id, question_id, revision,
      reviewer_id, operation_id, reason, reviewed_at, action, correct, withdraw_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(receipt.id, activityId, receipt.submissionId, receipt.targetId, receipt.questionId, receipt.revision,
    reviewer, command.operationId, command.reason, clock().toISOString(), command.action, correct, withdrawId);
  return receipt;
}

function reviewReceipt({ id, submissionId, targetId, questionId, revision }: Event) {
  return { id, submissionId, targetId, questionId, revision };
}
