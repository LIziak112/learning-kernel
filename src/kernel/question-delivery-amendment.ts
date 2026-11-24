import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AuthorizeChoiceDraftAmendment } from "../contracts/choice-amendment.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { questionDeliveryDraftValue } from "../contracts/question-delivery.ts";
import type { QuestionDeliveryAmendmentScope, ParsedQuestionDeliveryDraftAmendment } from "../contracts/question-delivery-amendment.ts";
import { responseValue } from "../contracts/response.ts";
import type { ReadingActivity } from "./activity.ts";
import { requireChoiceReviewerActivity } from "./choice-reviewer.ts";
import { choiceRevisionBeforeAnswers } from "./choice-snapshot-store.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import {
  QuestionDeliveryConflict, questionDeliveryPosition, requireFrozenQuestion, requireOpenRound, requireQuestionDeliverySlot,
} from "./question-delivery-drafts.ts";
import { publicDraft, readQuestionDraftHead, readQuestionDraftRevision } from "./question-draft-store.ts";
import { frozenResponseType } from "./question-types.ts";
import { requireAvailableTool } from "./reading-progress.ts";
import type { Registry } from "./registry.ts";
import { submittedSlots } from "./submission-store.ts";
import { saveWorkVersion } from "./work-versions.ts";

type Scope = QuestionDeliveryAmendmentScope;
type Position = { stepAttemptId: string; slotId: string; questionId: string };

const storedAmendment = z.strictObject({ workId: z.uuid(), revision: z.int().positive(), reason: z.string() });
const amendmentEntry = z.strictObject({
  revision: z.int().positive(), reviewerId: z.string(), reason: z.string(), amendedAt: z.iso.datetime(),
});
const snapshotEntry = z.strictObject({
  revision: z.int().positive(), previousQuestionVersion: z.int().positive(), questionVersion: z.int().positive(),
  reviewerId: z.string(), reason: z.string(), revisedAt: z.iso.datetime(),
});

export function deliveryPosition(registry: Registry, activity: ReadingActivity, scope: Scope): Position {
  const slot = requireQuestionDeliverySlot(activity, scope.slotId);
  requireAvailableTool(registry, activity.step, slot.type);
  if (!activity.practice.questions.some(question => question.id === scope.questionId)) throw new LearningError(422, "INVALID_QUESTION");
  return { stepAttemptId: scope.stepAttemptId, slotId: questionDeliveryPosition(slot, scope.slotId, scope.questionId), questionId: scope.questionId };
}

function deliveryQuestion(registry: Registry, activity: ReadingActivity, scope: Scope) {
  const position = deliveryPosition(registry, activity, scope);
  return { position, question: requireFrozenQuestion(activity, scope) };
}

export function openDraftState(database: DatabaseSync, activity: ReadingActivity, position: Position) {
  requireOpenRound(activity);
  if (submittedSlots(database, activity.stepAttemptId).has(position.slotId)) throw new LearningError(409, "ALREADY_SUBMITTED");
  const head = readQuestionDraftHead(database, activity.activityId, position, questionDeliveryDraftValue);
  const revision = head?.revision ?? choiceRevisionBeforeAnswers(database, position);
  return { head, revision };
}

export function readQuestionDeliveryDraftForAmendment(
  database: DatabaseSync, registry: Registry, reviewer: string, activityId: string, scope: Scope, authorize?: AuthorizeChoiceDraftAmendment,
) {
  return readTransaction(database, () => {
    const activity = amendmentActivity(database, reviewer, activityId, scope, "read", authorize);
    const { position } = deliveryQuestion(registry, activity, scope);
    const { head, revision } = openDraftState(database, activity, position);
    const { slotId, questionId, questionVersion } = scope;
    const current = head ? { ...publicDraft(head), slotId } : { slotId, questionId, questionVersion, value: null, revision, changeCount: 0 };
    return { ...current, history: amendmentHistory(database, activityId, position) };
  });
}

export function amendQuestionDeliveryDraft(
  database: DatabaseSync, registry: Registry, reviewer: string, activityId: string, input: ParsedQuestionDeliveryDraftAmendment,
  clock: () => Date, authorize?: AuthorizeChoiceDraftAmendment,
) {
  return writeTransaction(database, () => {
    const activity = amendmentActivity(database, reviewer, activityId, input, "amend", authorize);
    const { question, position } = deliveryQuestion(registry, activity, input);
    const value = responseValue.parse(frozenResponseType(registry, activity.practice, question).parseValue(input.value, question));
    const previous = recoverAmendment(database, reviewer, activityId, position, input, value);
    if (previous) return { ...previous, slotId: input.slotId };
    const { head, revision } = openDraftState(database, activity, position);
    if (revision !== input.baseRevision) throw new QuestionDeliveryConflict({ revision, value: head?.value ?? null }, undefined, input.questionId);
    const { questionVersion } = input;
    const draft = saveWorkVersion(database, { activityId, step: { id: position.stepAttemptId, slotId: position.slotId,
      questionId: position.questionId } }, { questionVersion, value }, head?.workId);
    database.prepare(`
      INSERT INTO choice_draft_amendments (work_id, revision, reviewer_id, operation_id, reason, amended_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(draft.id, draft.version, reviewer, input.operationId, input.reason, clock().toISOString());
    database.prepare("DELETE FROM choice_draft_latest_operations WHERE work_id = ?").run(draft.id);
    return { slotId: input.slotId, questionId: input.questionId, questionVersion, value, revision: revision + 1,
      changeCount: head?.changeCount ?? 0 };
  });
}

function amendmentActivity(
  database: DatabaseSync, reviewerId: string, activityId: string, scope: Scope, action: "read" | "amend",
  authorize?: AuthorizeChoiceDraftAmendment,
) {
  return requireChoiceReviewerActivity(database, reviewerId, activityId, scope, permitted => authorize?.({ ...permitted, action })).activity;
}

function recoverAmendment(
  database: DatabaseSync, reviewer: string, activityId: string, position: Position, input: ParsedQuestionDeliveryDraftAmendment,
  value: unknown,
) {
  const row = database.prepare(`
    SELECT a.work_id AS workId, a.revision, a.reason
    FROM choice_draft_amendments a JOIN works w ON w.id = a.work_id
    WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.slot_id = ? AND w.question_id = ?
      AND a.reviewer_id = ? AND a.operation_id = ?
  `).get(activityId, position.stepAttemptId, position.slotId, position.questionId, reviewer, input.operationId);
  if (!row) return undefined;
  const { workId, revision, reason } = storedAmendment.parse(row);
  const previous = publicDraft(readQuestionDraftRevision(database, workId, revision, questionDeliveryDraftValue));
  if (previous.questionVersion !== input.questionVersion || !isDeepStrictEqual(previous.value, value)
    || previous.revision - 1 !== input.baseRevision || reason !== input.reason) throw new LearningError(409, "OPERATION_CONFLICT");
  return previous;
}

function amendmentHistory(database: DatabaseSync, activityId: string, position: Position) {
  const amendments = database.prepare(`
    SELECT v.version + COALESCE((SELECT MAX(s.revision) FROM choice_snapshot_revisions s
        WHERE s.step_attempt_id = w.step_attempt_id AND s.slot_id = w.slot_id AND s.question_id = w.question_id), 0) AS revision,
      a.reviewer_id AS reviewerId, a.reason, a.amended_at AS amendedAt
    FROM choice_draft_amendments a JOIN works w ON w.id = a.work_id JOIN work_versions v ON v.work_id = a.work_id AND v.version = a.revision
    WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.slot_id = ? AND w.question_id = ? ORDER BY a.revision
  `).all(activityId, position.stepAttemptId, position.slotId, position.questionId).map(row => amendmentEntry.parse(row));
  const snapshots = database.prepare(`
    SELECT revision, previous_question_version AS previousQuestionVersion, question_version AS questionVersion,
      reviewer_id AS reviewerId, reason, revised_at AS revisedAt
    FROM choice_snapshot_revisions WHERE step_attempt_id = ? AND slot_id = ? AND question_id = ? ORDER BY revision
  `).all(position.stepAttemptId, position.slotId, position.questionId).map(row => snapshotEntry.parse(row));
  return { amendments, snapshots };
}
