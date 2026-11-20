import type { DatabaseSync } from "node:sqlite";
import { choiceDraftValue } from "../contracts/choice-draft.ts";
import type { ChoiceDraftInput, ChoiceDraftScope, CurrentChoiceDraftMode, UnversionedChoiceDraftInput } from "../contracts/choice-draft.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { recordChoiceDraftChange } from "./choice-draft-activity.ts";
import { choiceRevisionBeforeAnswers } from "./choice-snapshot-store.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { boundOutput } from "./reading-progress.ts";
import { saveWorkVersion } from "./work-versions.ts";
import {
  isLatestQuestionDraftOperation, publicDraft as draftReceipt, QuestionDraftConflict, readQuestionDraftHead, readQuestionDraftOperation,
  readQuestionDraftRevision, readQuestionDrafts, rememberQuestionDraftOperation,
} from "./question-draft-store.ts";

export { draftReceipt };

export class ChoiceDraftConflict extends QuestionDraftConflict<{ revision: number; choice: string | null }> {}

export function readChoiceDrafts(database: DatabaseSync, activityId: string, stepAttemptId: string) {
  return readQuestionDrafts(database, activityId, stepAttemptId, choiceDraftValue);
}

type DraftInput = ChoiceDraftInput | UnversionedChoiceDraftInput;
type DraftQuestion = ReadingActivity["practice"]["questions"][number];

export function saveChoiceDraft(
  database: DatabaseSync, student: string, activityId: string, input: DraftInput, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, student, activityId, input.stepAttemptId);
    if (activity.step.submit.slots[input.slotId]?.type === "oneResponsePerQuestion") throw new LearningError(422, "INVALID_SLOT");
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
  if (current && isLatestQuestionDraftOperation(database, current.workId, input.operationId)) {
    if (current.choice !== input.choice) throw new ChoiceDraftConflict({ revision: current.revision, choice: current.choice });
    return current;
  }
  requireSaveMode(mode);
  requireWritableChoice(question, input.choice);
  const head = writeAtRevision(database, activityId, input, current, clock);
  rememberQuestionDraftOperation(database, input, head);
  return head;
}

function requireSaveMode(mode: CurrentChoiceDraftMode) {
  if (mode === "replayLatestOnly") throw new LearningError(409, "DRAFT_REPLAY_REQUIRED");
}

function saveVersionedChoice(database: DatabaseSync, activity: ReadingActivity, input: ChoiceDraftInput, clock: () => Date) {
  const { activityId } = activity;
  const previous = recoverOperation(database, activityId, input);
  if (previous) return previous;
  requireWritableChoice(requireDraftQuestion(activity, input), input.choice);
  const current = readChoiceHead(database, activityId, input);
  const head = writeAtRevision(database, activityId, input, current, clock);
  rememberQuestionDraftOperation(database, input, head);
  return head;
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
  return readQuestionDraftRevision(database, workId, revision, choiceDraftValue);
}

function recoverOperation(database: DatabaseSync, activityId: string, input: ChoiceDraftInput) {
  const previous = readQuestionDraftOperation(database, activityId, input, choiceDraftValue);
  if (!previous) return undefined;
  const { baseRevision, draft } = previous;
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

export function readChoiceHead(database: DatabaseSync, activityId: string, scope: ChoiceDraftScope) {
  return readQuestionDraftHead(database, activityId, scope, choiceDraftValue);
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
