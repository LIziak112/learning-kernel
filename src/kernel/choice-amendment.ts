import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuthorizeChoiceDraftAmendment, ChoiceDraftAmendmentInput, ChoiceDraftAmendmentScope } from "../contracts/choice-amendment.ts";
import { requireChoiceReviewerActivity } from "./choice-reviewer.ts";
import { appendChoiceVersion, ChoiceDraftConflict, choiceState, draftReceipt, readChoiceHead, readChoiceRevision, requireDraftQuestion,
  requireWritableChoice } from "./choice-drafts.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const storedAmendment = z.strictObject({ workId: z.uuid(), revision: z.int().positive(), reason: z.string() });

export function readChoiceDraftForAmendment(
  database: DatabaseSync, reviewer: string, activityId: string, scope: ChoiceDraftAmendmentScope, authorize?: AuthorizeChoiceDraftAmendment,
) {
  return readTransaction(database, () => {
    const activity = requireAmendmentAccess(database, reviewer, activityId, scope, "read", authorize);
    requireDraftQuestion(activity, scope);
    const current = readChoiceHead(database, activityId, scope);
    const { slotId, questionId, questionVersion } = scope;
    const { choice, revision } = choiceState(database, scope, current);
    return current ? draftReceipt(current) : { slotId, questionId, questionVersion, choice, revision, changeCount: 0 };
  });
}

export function amendChoiceDraft(
  database: DatabaseSync, reviewer: string, activityId: string, input: ChoiceDraftAmendmentInput,
  clock: () => Date, authorize?: AuthorizeChoiceDraftAmendment,
) {
  return writeTransaction(database, () => {
    const activity = requireAmendmentAccess(database, reviewer, activityId, input, "amend", authorize);
    const previous = recoverAmendment(database, reviewer, activityId, input);
    if (previous) return draftReceipt(previous);
    requireWritableChoice(requireDraftQuestion(activity, input), input.choice);
    const current = readChoiceHead(database, activityId, input);
    const { revision, choice } = choiceState(database, input, current);
    if (revision !== input.baseRevision) throw new ChoiceDraftConflict({ revision, choice });
    const written = appendChoiceVersion(database, activityId, input, current, clock, "reviewer");
    database.prepare(`
      INSERT INTO choice_draft_amendments (work_id, revision, reviewer_id, operation_id, reason, amended_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(written.workId, written.workVersion, reviewer, input.operationId, input.reason, clock().toISOString());
    database.prepare("DELETE FROM choice_draft_latest_operations WHERE work_id = ?").run(written.workId);
    return draftReceipt(written);
  });
}

function requireAmendmentAccess(
  database: DatabaseSync, reviewerId: string, activityId: string, scope: ChoiceDraftAmendmentScope, action: "read" | "amend",
  authorize?: AuthorizeChoiceDraftAmendment,
) {
  return requireChoiceReviewerActivity(database, reviewerId, activityId, scope, permitted => authorize?.({ ...permitted, action })).activity;
}

function recoverAmendment(database: DatabaseSync, reviewer: string, activityId: string, input: ChoiceDraftAmendmentInput) {
  const row = database.prepare(`
    SELECT a.work_id AS workId, a.revision, a.reason
    FROM choice_draft_amendments a JOIN works w ON w.id = a.work_id
    WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.slot_id = ? AND w.question_id = ?
      AND a.reviewer_id = ? AND a.operation_id = ?
  `).get(activityId, input.stepAttemptId, input.slotId, input.questionId, reviewer, input.operationId);
  if (!row) return undefined;
  const { workId, revision, reason } = storedAmendment.parse(row);
  const previous = readChoiceRevision(database, workId, revision);
  if (previous.questionVersion !== input.questionVersion || previous.choice !== input.choice
    || previous.revision - 1 !== input.baseRevision || reason !== input.reason) throw new LearningError(409, "OPERATION_CONFLICT");
  return previous;
}
