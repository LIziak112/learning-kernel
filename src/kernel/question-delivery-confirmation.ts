import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuthorizeConfirmationRecovery, ConfirmationKey, VerifyOriginal } from "../contracts/choice-confirmation.ts";
import { questionDeliveryIntent, questionDeliveryView, readQuestionDelivery } from "../contracts/question-delivery.ts";
import type { QuestionDeliveryInput } from "../contracts/question-delivery.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { LearningError } from "../contracts/learning-error.ts";
import {
  confirmedDraftChangeCount, confirmedWorkForOperation, mapConfirmationQuestions, requireConfirmationRecovery,
  sameQuestionIntent, writeQuestionConfirmation,
} from "./question-confirmation.ts";
import {
  deliveryDraftHead, QuestionDeliveryConflict, questionDeliveryPosition, requireFrozenQuestion, requireOpenRound, requireQuestionDeliverySlot,
} from "./question-delivery-drafts.ts";
import { recoverQuestionDeliveryAssessment, registerDeliveryAssessment } from "./question-delivery-evaluation.ts";
import type { DeliverySlot } from "./question-delivery-publication.ts";
import { choiceRevisionBeforeAnswers } from "./choice-snapshot-store.ts";
import { frozenResponseType } from "./question-types.ts";
import { requireAvailableTool, requireBeforeDeadline } from "./reading-progress.ts";
import type { Registry } from "./registry.ts";
import { submittedSlots } from "./submission-store.ts";

type RequestQuestion = QuestionDeliveryInput["questions"][number];

export function confirmQuestionDelivery(
  database: DatabaseSync, registry: Registry, studentId: string, activityId: string, input: QuestionDeliveryInput, clock: () => Date,
  verifyOriginal: VerifyOriginal | undefined, authorize: AuthorizeConfirmationRecovery | undefined,
) {
  return writeTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, input.stepAttemptId);
    const previous = confirmedWorkForOperation(database, activityId, input);
    if (previous) {
      requireConfirmationRecovery({ studentId, activityId, stepAttemptId: input.stepAttemptId, operationId: input.operationId }, authorize);
      const content = readQuestionDelivery(previous.content);
      if (!content || content.source !== input.source || content.slotId !== input.slotId || !sameQuestionIntent(questionDeliveryIntent(content), input.questions)) {
        throw new LearningError(409, "OPERATION_CONFLICT");
      }
      return previous.receipt;
    }
    requireOpenRound(activity);
    const slot = requireQuestionDeliverySlot(activity, input.slotId);
    requireAvailableTool(registry, activity.step, slot.type);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const { requestQuestions, selected, ...placement } = deliveryPlacement(database, activity, input, slot);
    const decisions = selected.map(question => freezeDeliveryDraft(database, registry, activity, input.slotId, slot, question));
    const questions = decisions.map(({ question }) => question);
    const answeredQuestionIds = new Set(decisions.filter(({ answered }) => answered).map(({ question }) => question.questionId));
    const content = { kind: "questionDelivery" as const, slotId: input.slotId, questions };
    const submitted = input.source === "finish" ? { ...content, source: input.source, requestQuestions } : { ...content, source: input.source };
    const receipt = writeQuestionConfirmation(database, activity, studentId, input, slot.targetId, submitted, now, verifyOriginal,
      { ...placement, answeredQuestionIds });
    registerDeliveryAssessment(database, activity, receipt, submitted, slot.targetId);
    return receipt;
  });
}

function deliveryPlacement(database: DatabaseSync, activity: ReadingActivity, input: QuestionDeliveryInput, slot: DeliverySlot) {
  if ((input.source === "whole") !== (slot.delivery.mode === "whole")) throw new LearningError(422, "INVALID_SLOT");
  const submitted = submittedSlots(database, activity.stepAttemptId);
  if (input.source === "question") {
    const [question] = input.questions;
    requireFrozenQuestion(activity, question);
    const slotId = questionDeliveryPosition(slot, input.slotId, question.questionId);
    if (submitted.has(slotId)) throw new LearningError(409, "ALREADY_SUBMITTED");
    return { slotId, finishes: submitted.size + 1 === activity.practice.questions.length, selected: [question], requestQuestions: [question] };
  }
  const requestQuestions = mapConfirmationQuestions(activity, input.questions, question => question);
  const selected = requestQuestions.filter(question => !submitted.has(questionDeliveryPosition(slot, input.slotId, question.questionId)));
  if (!selected.length) throw new LearningError(409, "ALREADY_SUBMITTED");
  return { slotId: input.slotId, finishes: true, selected, requestQuestions };
}

function freezeDeliveryDraft(
  database: DatabaseSync, registry: Registry, activity: ReadingActivity, logicalSlotId: string, slot: DeliverySlot, question: RequestQuestion,
) {
  const slotId = questionDeliveryPosition(slot, logicalSlotId, question.questionId);
  const head = deliveryDraftHead(database, activity, slotId, question.questionId);
  const { revision, value } = head ?? {
    revision: choiceRevisionBeforeAnswers(database, { stepAttemptId: activity.stepAttemptId, slotId, questionId: question.questionId }),
    value: null,
  };
  if (revision !== question.revision) throw new QuestionDeliveryConflict({ revision, value }, "ANSWER_REVISION_CONFLICT", question.questionId);
  const answered = value !== null && isDeliveryAnswered(registry, activity, question, value);
  if (!answered && !slot.confirmFromDrafts.allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
  return { question: { ...question, value }, answered };
}

const answeredSchema = z.boolean();

function isDeliveryAnswered(registry: Registry, activity: ReadingActivity, request: RequestQuestion, value: unknown) {
  const question = requireFrozenQuestion(activity, request);
  const type = frozenResponseType(registry, activity.practice, question);
  const bindings = activity.practice.questionAnswerRules;
  const reference = bindings && Object.hasOwn(bindings, request.questionId) ? bindings[request.questionId] : undefined;
  if (!reference) return type.isAnswered(value, question);
  const rule = registry.answerRule(reference, type.id);
  if (!rule) throw new LearningError(503, "ANSWER_RULE_UNAVAILABLE");
  return answeredSchema.parse(rule.isAnswered(type.parseValue(value, question)));
}

export function recoverQuestionDelivery(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey,
  authorize: AuthorizeConfirmationRecovery | undefined, mode: "automatic" | "declared",
) {
  return readTransaction(database, () => {
    const activity = loadStudentReadingActivity(database, studentId, activityId, key.stepAttemptId);
    requireConfirmationRecovery({ studentId, activityId, stepAttemptId: key.stepAttemptId, operationId: key.operationId }, authorize);
    const recovered = confirmedWorkForOperation(database, activityId, key);
    const content = recovered && readQuestionDelivery(recovered.content);
    if (!recovered || !content) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
    const { receipt } = recovered;
    const { id, version } = activity.practice;
    const slot = requireQuestionDeliverySlot(activity, content.slotId);
    const draftChangeCounts = content.questions.map(question => {
      const slotId = questionDeliveryPosition(slot, content.slotId, question.questionId);
      const draft = deliveryDraftHead(database, activity, slotId, question.questionId);
      return { questionId: question.questionId, changeCount: confirmedDraftChangeCount(question, draft || undefined, "value") };
    });
    const confirmation = {
      receipt, practice: { id, version }, confirmation: questionDeliveryView(content), requestQuestions: questionDeliveryIntent(content),
      draftChangeCounts,
    };
    return { ...confirmation, ...recoverQuestionDeliveryAssessment(database, activity, receipt, content, mode) };
  });
}
