import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { choiceDraftValue } from "../contracts/choice-draft.ts";
import type { ChoiceDraftInput, ChoiceDraftScope, CurrentChoiceDraftMode, UnversionedChoiceDraftInput } from "../contracts/choice-draft.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { recordChoiceDraftChange } from "./choice-draft-activity.ts";
import { choiceRevisionBeforeAnswers, choiceSnapshotOffsetForWork } from "./choice-snapshot-store.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { boundOutput } from "./reading-progress.ts";
import { saveWorkVersion } from "./work-versions.ts";

export class ChoiceDraftConflict extends LearningError {
  readonly current: Readonly<{ revision: number; choice: string | null }>;

  constructor(current: ChoiceDraftConflict["current"], code: "ANSWER_REVISION_CONFLICT" | "OPERATION_CONFLICT" = "ANSWER_REVISION_CONFLICT") {
    super(409, code);
    this.current = current;
  }
}

const storedVersion = z.object({
  workId: z.uuid(), slotId: z.string(), questionId: z.string(), workVersion: z.int().positive(), revision: z.int().positive(), changeCount: z.int().nonnegative(), content: z.string(),
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

function decodeChoice({ content, ...version }: z.infer<typeof storedVersion>) {
  return { ...version, ...choiceDraftValue.parse(JSON.parse(content)) };
}

export function draftReceipt({ workId, workVersion, ...draft }: ReturnType<typeof decodeChoice>) {
  return draft;
}

export function readChoiceDrafts(database: DatabaseSync, activityId: string, stepAttemptId: string) {
  return database.prepare(currentDrafts + "ORDER BY w.slot_id, w.question_id").all(activityId, stepAttemptId)
    .map(row => draftReceipt(decodeChoice(storedVersion.parse(row))));
}

type DraftInput = ChoiceDraftInput | UnversionedChoiceDraftInput;
type DraftQuestion = ReadingActivity["practice"]["questions"][number];

export function saveChoiceDraft(
  database: DatabaseSync, student: string, activityId: string, input: DraftInput, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, student, activityId, input.stepAttemptId);
    if (input.operationId !== undefined) return draftReceipt(saveVersionedChoice(database, activity, input, clock));
    requireWritableChoice(requireDraftQuestion(activity, input), input.choice);
    return draftReceipt(saveUnversionedChoice(database, activityId, input, clock));
  });
}

export function saveCurrentChoiceDraft(
  database: DatabaseSync, student: string, activityId: string, input: DraftInput, mode: CurrentChoiceDraftMode, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, student, activityId, input.stepAttemptId);
    const question = requireDraftQuestion(activity, input);
    if (input.operationId !== undefined) return draftReceipt(saveAtCurrentHead(database, activityId, question, input, mode, clock));
    requireSaveMode(mode);
    requireWritableChoice(question, input.choice);
    return draftReceipt(saveUnversionedChoice(database, activityId, input, clock));
  });
}

function saveAtCurrentHead(
  database: DatabaseSync, activityId: string, question: DraftQuestion, input: ChoiceDraftInput, mode: CurrentChoiceDraftMode, clock: () => Date,
) {
  const current = readChoiceHead(database, activityId, input);
  if (current && isLatestOperation(database, current.workId, input.operationId)) {
    if (current.choice !== input.choice) throw new ChoiceDraftConflict({ revision: current.revision, choice: current.choice });
    return current;
  }
  requireSaveMode(mode);
  requireWritableChoice(question, input.choice);
  const head = writeAtRevision(database, activityId, input, current, clock);
  rememberVersionedChoice(database, input, head);
  return head;
}

function requireSaveMode(mode: CurrentChoiceDraftMode) {
  if (mode === "replayLatestOnly") throw new LearningError(409, "DRAFT_REPLAY_REQUIRED");
}

function isLatestOperation(database: DatabaseSync, workId: string, operationId: string) {
  return Boolean(database.prepare(`
    SELECT 1 FROM choice_draft_latest_operations WHERE work_id = ? AND operation_id = ?
  `).get(workId, operationId));
}

function saveVersionedChoice(database: DatabaseSync, activity: ReadingActivity, input: ChoiceDraftInput, clock: () => Date) {
  const { activityId } = activity;
  const previous = recoverOperation(database, activityId, input);
  if (previous) return previous;
  requireWritableChoice(requireDraftQuestion(activity, input), input.choice);
  const current = readChoiceHead(database, activityId, input);
  const head = writeAtRevision(database, activityId, input, current, clock);
  rememberVersionedChoice(database, input, head);
  return head;
}

function rememberVersionedChoice(database: DatabaseSync, input: ChoiceDraftInput, head: ReturnType<typeof decodeChoice>) {
  database.prepare(`
    INSERT INTO choice_draft_operations (work_id, operation_id, base_revision, revision)
    VALUES (?, ?, ?, ?) ON CONFLICT (work_id, operation_id) DO NOTHING
  `).run(head.workId, input.operationId, input.baseRevision, head.workVersion);
  database.prepare(`
    INSERT INTO choice_draft_latest_operations (work_id, operation_id) VALUES (?, ?)
    ON CONFLICT (work_id) DO UPDATE SET operation_id = excluded.operation_id
  `).run(head.workId, input.operationId);
}

function saveUnversionedChoice(
  database: DatabaseSync, activityId: string, input: UnversionedChoiceDraftInput, clock: () => Date,
) {
  const current = readChoiceHead(database, activityId, input);
  const { revision, choice } = choiceState(database, input, current);
  if (revision !== (current?.changeCount ?? 0) || (current && hasVersionedOperation(database, current.workId))) {
    throw new ChoiceDraftConflict({ revision, choice });
  }
  return appendChoiceVersion(database, activityId, input, current, clock);
}

function hasVersionedOperation(database: DatabaseSync, workId: string) {
  return Boolean(database.prepare("SELECT 1 FROM choice_draft_operations WHERE work_id = ? LIMIT 1").get(workId));
}

export function readChoiceRevision(database: DatabaseSync, workId: string, revision: number) {
  const row = database.prepare(`
    SELECT ${versionColumns} FROM works w JOIN work_versions v ON v.work_id = w.id
    WHERE w.id = ? AND v.version = ?
  `).get(workId, revision);
  return decodeChoice(storedVersion.parse(row));
}

function recoverOperation(database: DatabaseSync, activityId: string, input: ChoiceDraftInput) {
  const row = database.prepare(`
    SELECT ${versionColumns}, o.base_revision AS baseRevision
    FROM choice_draft_operations o
    JOIN works w ON w.id = o.work_id
    JOIN work_versions v ON v.work_id = o.work_id AND v.version = o.revision
    WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.slot_id = ? AND w.question_id = ? AND o.operation_id = ?
  `).get(activityId, input.stepAttemptId, input.slotId, input.questionId, input.operationId);
  if (!row) return undefined;
  const { baseRevision, ...stored } = storedOperation.parse(row);
  const draft = decodeChoice(stored);
  if (draft.questionVersion !== input.questionVersion) throw new LearningError(409, "OPERATION_CONFLICT");
  if (baseRevision !== input.baseRevision || draft.choice !== input.choice) {
    const current = readChoiceHead(database, activityId, input);
    if (current?.questionVersion !== input.questionVersion) throw new LearningError(409, "OPERATION_CONFLICT");
    throw new ChoiceDraftConflict({ revision: current.revision, choice: current.choice }, "OPERATION_CONFLICT");
  }
  return draft;
}

export function requireDraftQuestion(activity: ReadingActivity, input: ChoiceDraftScope) {
  if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
  const slot = boundOutput(activity.step, input.slotId);
  if (slot.type !== "oneChoicePerQuestion" || activity.step.inputs[slot.source]?.from !== "questions") {
    throw new LearningError(422, "INVALID_SLOT");
  }
  const question = activity.practice.questions.find(question => question.id === input.questionId);
  if (!question) throw new LearningError(422, "INVALID_QUESTION");
  if (question.version !== input.questionVersion) throw new LearningError(409, "QUESTION_REVISION_STALE");
  return question;
}

export function requireWritableChoice(question: DraftQuestion, choice: string) {
  if (!Object.hasOwn(question.options, choice)) throw new LearningError(422, "INVALID_CHOICE");
}

export function readChoiceHead(database: DatabaseSync, activityId: string, { stepAttemptId, slotId, questionId }: ChoiceDraftScope) {
  const row = database.prepare(currentDrafts + "AND w.slot_id = ? AND w.question_id = ?")
    .get(activityId, stepAttemptId, slotId, questionId);
  return row && decodeChoice(storedVersion.parse(row));
}

function writeAtRevision(
  database: DatabaseSync, activityId: string, input: ChoiceDraftInput, current: ReturnType<typeof readChoiceHead>, clock: () => Date,
) {
  if (current?.choice === input.choice) return current;
  const { revision, choice } = choiceState(database, input, current);
  if (revision !== input.baseRevision) throw new ChoiceDraftConflict({ revision, choice });
  return appendChoiceVersion(database, activityId, input, current, clock);
}

export function choiceState(database: DatabaseSync, scope: ChoiceDraftScope, current: ReturnType<typeof readChoiceHead>) {
  return current ?? { revision: choiceRevisionBeforeAnswers(database, scope), choice: null };
}

export function appendChoiceVersion(
  database: DatabaseSync, activityId: string, input: DraftInput, current: ReturnType<typeof readChoiceHead>, clock: () => Date,
  actor: "student" | "reviewer" = "student",
) {
  const { stepAttemptId, slotId, questionId, questionVersion, choice } = input;
  if (actor === "student" && current?.choice !== choice) recordChoiceDraftChange(database, activityId, clock());
  const scope = { activityId, step: { id: stepAttemptId, slotId, questionId } };
  const draft = saveWorkVersion(database, scope, { questionVersion, choice }, current?.workId);
  const { revision } = choiceState(database, input, current);
  return { workId: draft.id, workVersion: draft.version, slotId, questionId, revision: revision + 1, questionVersion, choice,
    changeCount: (current?.changeCount ?? 0) + Number(actor === "student") };
}
