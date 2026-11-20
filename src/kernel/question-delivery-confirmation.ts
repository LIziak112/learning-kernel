import type { DatabaseSync } from "node:sqlite";
import type { AuthorizeConfirmationRecovery, ConfirmationKey, VerifyOriginal } from "../contracts/choice-confirmation.ts";
import { findQuestionAnswerRule } from "../contracts/question-answer-rule.ts";
import type { BoundQuestionAnswerRules } from "../contracts/question-answer-rule.ts";
import { questionDeliveryIntent, questionDeliveryView, readQuestionDelivery } from "../contracts/question-delivery.ts";
import type { AuthorizeQuestionDeliveryReview, QuestionDeliveryInput } from "../contracts/question-delivery.ts";
import { hasStoredResponse } from "../contracts/response.ts";
import type { StoredResponseValue } from "../contracts/response.ts";
import { loadActivity, loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import type { PublicationEvaluators } from "./publication-bindings.ts";
import {
  confirmedDraftChangeCount, confirmedWorkForOperation, mapConfirmationQuestions, requireConfirmationRecovery,
  sameQuestionIntent, writeQuestionConfirmation,
} from "./question-confirmation.ts";
import {
  deliveryDraftHead, QuestionDeliveryConflict, questionDeliveryPosition, requireFrozenQuestion, requireQuestionDeliverySlot,
} from "./question-delivery-drafts.ts";
import { readManualReviewBasis, readManualReviewQuestions, recoverQuestionDeliveryEvaluation } from "./question-delivery-evaluation.ts";
import type { DeliverySlot } from "./question-delivery-publication.ts";
import { requireBeforeDeadline } from "./reading-progress.ts";
import { recordResponseReviewRequirements } from "./response-evaluation.ts";
import { submittedSlots } from "./submission-store.ts";

type RequestQuestion = QuestionDeliveryInput["questions"][number];

export function confirmQuestionDelivery(
  database: DatabaseSync, studentId: string, activityId: string, input: QuestionDeliveryInput, clock: () => Date,
  verifyOriginal: VerifyOriginal | undefined, authorize: AuthorizeConfirmationRecovery | undefined, answerRules: BoundQuestionAnswerRules,
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
    if (activity.completed) throw new LearningError(409, "ALREADY_SUBMITTED");
    const slot = requireQuestionDeliverySlot(activity, input.slotId);
    const now = clock();
    requireBeforeDeadline(activity, now);
    const { requestQuestions, selected, ...placement } = deliveryPlacement(database, activity, input, slot);
    const decisions = selected.map(question => freezeDeliveryDraft(database, activity, input.slotId, slot, question, answerRules));
    const questions = decisions.map(({ question }) => question);
    const answeredQuestionIds = new Set(decisions.filter(({ answered }) => answered).map(({ question }) => question.questionId));
    const content = { kind: "questionDelivery" as const, slotId: input.slotId, questions };
    const submitted = input.source === "finish" ? { ...content, source: input.source, requestQuestions } : { ...content, source: input.source };
    const receipt = writeQuestionConfirmation(database, activity, studentId, input, slot.targetId, submitted, now, verifyOriginal,
      { ...placement, answeredQuestionIds });
    if (activity.practice.grading.manualReview) {
      recordResponseReviewRequirements(database, receipt.id, questions.map(({ questionId }) => questionId));
    }
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
  database: DatabaseSync, activity: ReadingActivity, logicalSlotId: string, slot: DeliverySlot,
  question: RequestQuestion, rules: BoundQuestionAnswerRules,
) {
  const slotId = questionDeliveryPosition(slot, logicalSlotId, question.questionId);
  const head = deliveryDraftHead(database, activity, slotId, question.questionId);
  const { revision, value } = head ?? { revision: 0, value: null };
  if (revision !== question.revision) throw new QuestionDeliveryConflict({ revision, value }, "ANSWER_REVISION_CONFLICT", question.questionId);
  const answered = isDeliveryAnswered(activity, question, value, rules);
  if (!answered && !slot.confirmFromDrafts.allowUnanswered) throw new LearningError(422, "UNANSWERED_QUESTION");
  return { question: { ...question, value }, answered };
}

function isDeliveryAnswered(
  activity: ReadingActivity, question: RequestQuestion, value: StoredResponseValue | null, rules: BoundQuestionAnswerRules,
) {
  const bindings = activity.practice.questionAnswerRules;
  const reference = bindings && Object.hasOwn(bindings, question.questionId) ? bindings[question.questionId] : undefined;
  if (!reference) return hasStoredResponse(value);
  const { response } = requireFrozenQuestion(activity, question);
  const rule = findQuestionAnswerRule(rules, reference, response);
  if (!rule) throw new LearningError(503, "ANSWER_RULE_UNAVAILABLE");
  return value !== null && rule.isAnswered(value);
}

export function recoverQuestionDelivery(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey,
  authorize: AuthorizeConfirmationRecovery | undefined, registered: PublicationEvaluators, mode: "automatic" | "declared",
) {
  return writeTransaction(database, () => {
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
    const { assessment, manualReview } = activity.practice.grading;
    if (assessment) {
      const evaluation = recoverQuestionDeliveryEvaluation(database, activity, receipt, content, registered);
      return { ...confirmation, assessment: "automatic" as const, evaluation };
    }
    if (mode === "automatic") throw new LearningError(409, "ASSESSMENT_MODE_MISMATCH");
    if (manualReview) {
      const questions = readManualReviewQuestions(database, receipt, content);
      return { ...confirmation, assessment: "manual" as const, review: { questions } };
    }
    return { ...confirmation, assessment: "none" as const };
  });
}

export function readQuestionDeliveryReview(
  database: DatabaseSync, reviewerId: string, activityId: string, { stepAttemptId, operationId }: ConfirmationKey,
  authorize: AuthorizeQuestionDeliveryReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, studentId } = requireReviewActivity(database, reviewerId, activityId, stepAttemptId);
    const recovered = confirmedWorkForOperation(database, activityId, { protocolVersion: 1, stepAttemptId, operationId });
    if (!recovered) throw new LearningError(403, "FORBIDDEN");
    const { receipt } = recovered;
    const { id: submissionId, slotId } = receipt;
    if (authorize?.({ reviewerId, studentId, activityId, stepAttemptId, operationId, submissionId, slotId }) !== true) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const content = readQuestionDelivery(recovered.content);
    const manualReview = activity.practice.grading.manualReview;
    if (!manualReview || !content) throw new LearningError(404, "REVIEW_NOT_FOUND");
    const { id, version } = activity.practice;
    const basis = readManualReviewBasis(database, receipt, manualReview.keyRef);
    const questions = readManualReviewQuestions(database, receipt, content);
    return { receipt, practice: { id, version }, confirmation: questionDeliveryView(content), basis, questions };
  });
}

function requireReviewActivity(database: DatabaseSync, reviewerId: string, activityId: string, stepAttemptId: string) {
  const studentId = database.prepare(`
    SELECT a.student_id AS studentId FROM activities a
    JOIN step_attempts t ON t.activity_id = a.id
    LEFT JOIN reading_reviews r ON r.activity_id = a.id
    WHERE a.id = ? AND t.id = ? AND (r.activity_id IS NULL OR (r.reviewer_id = ? AND r.reviewer_active = 1))
  `).get(activityId, stepAttemptId, reviewerId)?.studentId;
  if (typeof studentId !== "string") throw new LearningError(403, "FORBIDDEN");
  const activity = loadActivity(database, studentId, activityId);
  if (activity.kind !== "reading" || activity.stepAttemptId !== stepAttemptId) throw new LearningError(403, "FORBIDDEN");
  return { activity, studentId };
}
