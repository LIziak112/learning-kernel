import type { DatabaseSync } from "node:sqlite";
import type { CurrentChoiceDraftMode } from "../contracts/choice-draft.ts";
import { questionDeliveryDraftValue } from "../contracts/question-delivery.ts";
import type { QuestionDeliveryDraftInput } from "../contracts/question-delivery.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import type { DeliverySlot } from "./question-delivery-publication.ts";
import { QuestionDraftConflict, readQuestionDraftHead, readQuestionDrafts } from "./question-draft-store.ts";
import { boundOutput } from "./reading-progress.ts";
import { saveCurrentResponse } from "./response-drafts.ts";
import { submittedSlots } from "./submission-store.ts";

type Value = QuestionDeliveryDraftInput["value"];

export class QuestionDeliveryConflict extends QuestionDraftConflict<{ revision: number; value: Value | null }> {
  readonly questionId: string | undefined;
  constructor(current: { revision: number; value: Value | null }, code?: "ANSWER_REVISION_CONFLICT" | "OPERATION_CONFLICT", questionId?: string) {
    super(current, code);
    this.questionId = questionId;
  }
}

export function saveQuestionDeliveryDraft(
  database: DatabaseSync, studentId: string, activityId: string, input: QuestionDeliveryDraftInput, mode: CurrentChoiceDraftMode, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    const slot = requireQuestionDeliverySlot(activity, input.slotId);
    const value = input.value;
    const question = requireFrozenQuestion(activity, input);
    requireDeliveryDraftValue(question, value);
    const slotId = questionDeliveryPosition(slot, input.slotId, input.questionId);
    if (submittedSlots(database, activity.stepAttemptId).has(slotId)) throw new LearningError(409, "ALREADY_SUBMITTED");
    const draft = saveCurrentResponse(database, activityId, { ...input, slotId }, mode, clock,
      { schema: questionDeliveryDraftValue, Conflict: QuestionDeliveryConflict });
    return { ...draft, slotId: input.slotId };
  });
}

export function readOpenDeliveryDrafts(
  database: DatabaseSync, activity: ReadingActivity, logicalSlotId: string, submitted: ReadonlySet<string>,
) {
  return readQuestionDrafts(database, activity.activityId, activity.stepAttemptId, questionDeliveryDraftValue)
    .filter(draft => !submitted.has(draft.slotId)).map(draft => ({ ...draft, slotId: logicalSlotId }));
}

export function deliveryDraftHead(database: DatabaseSync, activity: ReadingActivity, slotId: string, questionId: string) {
  return readQuestionDraftHead(database, activity.activityId, { stepAttemptId: activity.stepAttemptId, slotId, questionId }, questionDeliveryDraftValue);
}

export function requireQuestionDeliverySlot(activity: ReadingActivity, slotId: string) {
  const slot = boundOutput(activity.step, slotId);
  if (slot.type !== "questionDelivery") throw new LearningError(422, "INVALID_SLOT");
  return slot;
}

export function questionDeliveryPosition(slot: DeliverySlot, logicalSlotId: string, questionId: string) {
  if (slot.delivery.mode === "whole") return logicalSlotId;
  const slotId = slot.delivery.questionSlots[questionId];
  if (slotId === undefined || !Object.hasOwn(slot.delivery.questionSlots, questionId)) {
    throw new Error("冻结的题缺少交付位置");
  }
  return slotId;
}

export function requireFrozenQuestion(activity: ReadingActivity, { questionId, questionVersion }: { questionId: string; questionVersion: number }) {
  const question = activity.practice.questions.find(question => question.id === questionId);
  if (!question) throw new LearningError(422, "INVALID_QUESTION");
  if (question.version !== questionVersion) throw new LearningError(409, "QUESTION_REVISION_STALE");
  return question;
}

function requireDeliveryDraftValue(question: ReturnType<typeof requireFrozenQuestion>, value: Value) {
  const { response, options } = question;
  if (response === "booleanOrString") {
    if (typeof value === "object") throw new LearningError(422, "INVALID_RESPONSE");
    return;
  }
  if (response === "orderedTextBlanks") {
    if (typeof value !== "object" || value.some(item => typeof item !== "string")) {
      throw new LearningError(422, "INVALID_RESPONSE");
    }
    return;
  }
  requireFrozenOptions(response, options, value);
}

function requireFrozenOptions(
  format: "choice" | "optionIndexArray" | undefined, options: Readonly<Record<string, string>>, value: Value,
) {
  if (format === "choice") {
    if (typeof value !== "string" || !Object.hasOwn(options, value)) throw new LearningError(422, "INVALID_CHOICE");
    return;
  }
  if (format !== "optionIndexArray") throw new Error("冻结的题缺少作答形态");
  if (typeof value !== "object" || value.some(index => typeof index !== "number" || !Object.hasOwn(options, String(index)))) {
    throw new LearningError(422, "INVALID_OPTION_INDEX");
  }
}
