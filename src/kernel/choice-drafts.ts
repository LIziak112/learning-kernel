import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { choiceDraftValue } from "../contracts/choice-draft.ts";
import type { ChoiceDraftInput, UnversionedChoiceDraftInput } from "../contracts/choice-draft.ts";
import { loadStudentActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
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
  workId: z.uuid(), slotId: z.string(), questionId: z.string(), revision: z.int().positive(), content: z.string(),
});
const storedOperation = storedVersion.extend({ baseRevision: z.int().nonnegative() });
const currentDrafts = `
  SELECT w.id AS workId, w.slot_id AS slotId, w.question_id AS questionId, v.version AS revision, v.selection AS content
  FROM works w JOIN work_versions v ON v.work_id = w.id
    AND v.version = (SELECT MAX(version) FROM work_versions WHERE work_id = w.id)
  WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.question_id IS NOT NULL
`;

function decodeChoice({ content, ...version }: z.infer<typeof storedVersion>) {
  return { ...version, ...choiceDraftValue.parse(JSON.parse(content)) };
}

function draftReceipt({ workId, ...draft }: ReturnType<typeof decodeChoice>) {
  return { ...draft, changeCount: draft.revision };
}

export function readChoiceDrafts(database: DatabaseSync, activityId: string, stepAttemptId: string) {
  return database.prepare(currentDrafts + "ORDER BY w.slot_id, w.question_id").all(activityId, stepAttemptId)
    .map(row => draftReceipt(decodeChoice(storedVersion.parse(row))));
}

type DraftInput = ChoiceDraftInput | UnversionedChoiceDraftInput;

export function saveChoiceDraft(database: DatabaseSync, student: string, activityId: string, input: DraftInput) {
  return writeTransaction(database, () => {
    const activity = loadStudentActivity(database, student, activityId);
    if (activity.kind !== "reading" || activity.stepAttemptId !== input.stepAttemptId) throw new LearningError(403, "FORBIDDEN");
    const written = input.operationId === undefined
      ? saveUnversionedChoice(database, activity, input)
      : saveVersionedChoice(database, activity, input);
    return draftReceipt(written);
  });
}

function saveVersionedChoice(database: DatabaseSync, activity: ReadingActivity, input: ChoiceDraftInput) {
  const { activityId } = activity;
  const previous = recoverOperation(database, activityId, input);
  if (previous) return previous;
  requireWritableQuestion(activity, input);
  const head = writeAtRevision(database, activityId, input);
  database.prepare(`
    INSERT INTO choice_draft_operations (work_id, operation_id, base_revision, revision)
    VALUES (?, ?, ?, ?)
  `).run(head.workId, input.operationId, input.baseRevision, head.revision);
  return head;
}

function saveUnversionedChoice(database: DatabaseSync, activity: ReadingActivity, input: UnversionedChoiceDraftInput) {
  requireWritableQuestion(activity, input);
  const { activityId } = activity;
  const current = readChoiceHead(database, activityId, input);
  if (current && database.prepare("SELECT 1 FROM choice_draft_operations WHERE work_id = ? LIMIT 1").get(current.workId)) {
    throw new ChoiceDraftConflict({ revision: current.revision, choice: current.choice });
  }
  return appendChoiceVersion(database, activityId, input, current?.workId);
}

function recoverOperation(database: DatabaseSync, activityId: string, input: ChoiceDraftInput) {
  const row = database.prepare(`
    SELECT w.id AS workId, w.slot_id AS slotId, w.question_id AS questionId, o.base_revision AS baseRevision,
      o.revision, v.selection AS content
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

function requireWritableQuestion(activity: ReadingActivity, input: DraftInput) {
  if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
  const slot = boundOutput(activity.step, input.slotId);
  if (slot.type !== "oneChoicePerQuestion" || activity.step.inputs[slot.source]?.from !== "questions") {
    throw new LearningError(422, "INVALID_SLOT");
  }
  const question = activity.practice.questions.find(question => question.id === input.questionId);
  if (!question) throw new LearningError(422, "INVALID_QUESTION");
  if (question.version !== input.questionVersion) throw new LearningError(409, "QUESTION_REVISION_STALE");
  if (!Object.hasOwn(question.options, input.choice)) throw new LearningError(422, "INVALID_CHOICE");
}

function readChoiceHead(database: DatabaseSync, activityId: string, { stepAttemptId, slotId, questionId }: DraftInput) {
  const row = database.prepare(currentDrafts + "AND w.slot_id = ? AND w.question_id = ?")
    .get(activityId, stepAttemptId, slotId, questionId);
  return row && decodeChoice(storedVersion.parse(row));
}

function writeAtRevision(database: DatabaseSync, activityId: string, input: ChoiceDraftInput) {
  const current = readChoiceHead(database, activityId, input);
  if (current?.choice === input.choice) return current;
  const { revision, choice } = current ?? { revision: 0, choice: null };
  if (revision !== input.baseRevision) throw new ChoiceDraftConflict({ revision, choice });
  return appendChoiceVersion(database, activityId, input, current?.workId);
}

function appendChoiceVersion(database: DatabaseSync, activityId: string, input: DraftInput, workId?: string) {
  const { stepAttemptId, slotId, questionId, questionVersion, choice } = input;
  const scope = { activityId, step: { id: stepAttemptId, slotId, questionId } };
  const draft = saveWorkVersion(database, scope, { questionVersion, choice }, workId);
  return { workId: draft.id, slotId, questionId, revision: draft.version, questionVersion, choice };
}
