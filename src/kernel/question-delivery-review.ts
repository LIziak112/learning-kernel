import type { DatabaseSync } from "node:sqlite";
import { readChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { ConfirmationKey } from "../contracts/choice-confirmation.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { questionDeliveryView, readQuestionDelivery } from "../contracts/question-delivery.ts";
import type { QuestionDelivery } from "../contracts/question-delivery.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { readResponseConfirmation } from "../contracts/response.ts";
import type { AuthorizeReview, FrozenConfirmationVerdictMode, ReviewedDelivery, ReviewScope, VerdictCommand } from "../contracts/verdict.ts";
import { loadActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { confirmedWorkForOperation } from "./question-confirmation.ts";
import { requireQuestionDeliverySlot } from "./question-delivery-drafts.ts";
import { confirmedDeliveryAssessment, readManualReviewBasis, readManualReviewQuestions } from "./question-delivery-evaluation.ts";
import { boundOutput } from "./reading-progress.ts";
import { appendReview, eventView, repeatedReview } from "./verdict-history.ts";
import { questionVerdictStates, submissionReviewTarget } from "./verdict-state.ts";

type Fields = ReadonlySet<ReadingActivity["practice"]["policy"]["reviewer"]["fields"][number]>;
type Recovered = NonNullable<ReturnType<typeof confirmedWorkForOperation>>;
type Confirmed = { questions: readonly { questionId: string; questionVersion: number; value?: unknown; choice?: unknown }[] };

export function readQuestionDeliveryReview(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content, fields } = authorizedDelivery(database, reviewerId, activityId, key, authorize);
    const manualReview = activity.practice.grading.manualReview;
    if (!manualReview) throw new LearningError(404, "REVIEW_NOT_FOUND");
    const questions = readManualReviewQuestions(database, receipt, content.questions);
    return { ...reviewedDelivery(activity, receipt, content, fields), ...manualBasis(database, receipt, manualReview.keyRef, fields), questions };
  });
}

export function readQuestionDeliveryVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeReview | undefined,
) {
  return readTransaction(database, () => {
    const { activity, receipt, content, fields } = authorizedDelivery(database, reviewerId, activityId, key, authorize);
    const target = requireAssessment(database, receipt.id, requireQuestionDeliverySlot(activity, content.slotId).targetId);
    const manualReview = activity.practice.grading.manualReview;
    const { automatic, review } = confirmedDeliveryAssessment(activity, content);
    const assessmentIds = new Set([...automatic, ...review].map(({ questionId }) => questionId));
    const confirmed = content.questions.filter(({ questionId }) => assessmentIds.has(questionId));
    const questions = reviewedVerdicts(database, target, confirmed, automatic, fields);
    const reviewed = { ...reviewedDelivery(activity, receipt, { ...content, questions: confirmed }, fields), targetId: target.targetId, questions };
    if (manualReview) return { ...reviewed, assessment: "manual" as const, ...manualBasis(database, receipt, manualReview.keyRef, fields) };
    if (automatic.length) return { ...reviewed, assessment: "automatic" as const };
    return { ...reviewed, assessment: "teacherReview" as const };
  });
}

export function readChoiceConfirmationVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeReview | undefined,
) {
  return readFrozenConfirmationVerdicts(database, reviewerId, activityId, key, authorize, "choiceConfirmation", readChoiceConfirmation);
}

export function readResponseConfirmationVerdicts(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeReview | undefined,
) {
  return readFrozenConfirmationVerdicts(database, reviewerId, activityId, key, authorize, "responseConfirmation", readResponseConfirmation);
}

function readFrozenConfirmationVerdicts<Confirmation extends Confirmed>(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeReview | undefined,
  delivery: FrozenConfirmationVerdictMode, read: (content: unknown) => Confirmation | undefined,
) {
  return readTransaction(database, () => {
    const recovered = reviewConfirmation(database, reviewerId, activityId, key);
    const confirmation = read(recovered.content);
    if (!confirmation) throw new LearningError(404, "REVIEW_NOT_FOUND");
    const fields = authorizeRead(recovered, delivery, authorize);
    const { activity, receipt } = recovered;
    const target = requireAssessment(database, receipt.id, boundOutput(activity.step, receipt.slotId).targetId);
    const questions = reviewedVerdicts(database, target, confirmation.questions, confirmation.questions, fields);
    const { id, version } = activity.practice;
    return {
      receipt, practice: { id, version }, confirmation: projectAnswers(confirmation, fields), targetId: target.targetId,
      assessment: "automatic" as const, questions,
    };
  });
}

function frozenConfirmation(content: unknown, delivery: FrozenConfirmationVerdictMode) {
  return delivery === "responseConfirmation" ? readResponseConfirmation(content) : readChoiceConfirmation(content);
}

function reviewedVerdicts(
  database: DatabaseSync, target: ReturnType<typeof requireAssessment>,
  positions: readonly { questionId: string; questionVersion: number }[], automatic: readonly { questionId: string }[], fields: Fields,
) {
  const states = questionVerdictStates(database, target, positions);
  const unfinished = new Set(target.status === "pending" || target.status === "failed" ? automatic.map(({ questionId }) => questionId) : []);
  const waiting = target.status === "failed" ? "evaluationFailed" as const : "pendingEvaluation" as const;
  const basis = fields.has("gradingBasis");
  return states.map(({ questionId, questionVersion, revision, automatic: original, effective, history }) => {
    const state = {
      questionId, questionVersion, revision, ...basis && original && { automatic: original },
      ...fields.has("verdictHistory") && { history: history.map(eventView) },
    };
    if (effective) return { ...state, status: "judged" as const, ...basis && { effective } };
    return { ...state, status: unfinished.has(questionId) ? waiting : "needsReview" as const };
  });
}

export function writeQuestionDeliveryVerdict(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, command: VerdictCommand,
  authorize: AuthorizeReview | undefined, clock: () => Date, mode?: FrozenConfirmationVerdictMode,
) {
  return writeTransaction(database, () => {
    const recovered = reviewConfirmation(database, reviewerId, activityId, key);
    const { activity, receipt, content } = recovered;
    const delivery: ReviewedDelivery = mode ?? "questionDelivery";
    const { deliveryContent, questionVersion, targetId } = requireVerdictPosition(activity, receipt, content, command, mode);
    requireReviewPolicy(activity, "reviseQuestionVerdict");
    const { questionId, action } = command;
    if (authorize?.({ ...recovered.scope, delivery, purpose: "reviseVerdict", targetId, questionId, questionVersion, action }) !== true) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const target = requireAssessment(database, receipt.id, targetId);
    if (target.targetId !== targetId) throw new Error("评估目标与冻结提交不一致");
    if (deliveryContent) {
      const { automatic, review } = confirmedDeliveryAssessment(activity, deliveryContent);
      if (![...automatic, ...review].some(question => question.questionId === questionId)) throw new LearningError(403, "FORBIDDEN");
    }
    return repeatedReview(database, activityId, reviewerId, command) ?? appendReview(database, activityId, reviewerId, command, clock);
  });
}

function requireVerdictPosition(
  activity: ReadingActivity, receipt: SubmissionReceipt, content: unknown, command: VerdictCommand, mode: FrozenConfirmationVerdictMode | undefined,
) {
  const deliveryContent = mode === undefined ? readQuestionDelivery(content) : undefined;
  const confirmation = mode === undefined ? deliveryContent : frozenConfirmation(content, mode);
  if (!confirmation || command.submissionId !== receipt.id) throw new LearningError(403, "FORBIDDEN");
  const slot = deliveryContent ? requireQuestionDeliverySlot(activity, deliveryContent.slotId) : boundOutput(activity.step, receipt.slotId);
  const question = confirmation.questions.find(frozen => frozen.questionId === command.questionId);
  if (!question || command.targetId !== slot.targetId) throw new LearningError(403, "FORBIDDEN");
  return { deliveryContent, questionVersion: question.questionVersion, targetId: slot.targetId };
}

function requireReviewPolicy(activity: ReadingActivity, action?: "reviseQuestionVerdict"): Fields {
  const { fields, actions } = activity.practice.policy.reviewer;
  if (action ? !actions.includes(action) : fields.length === 0 && actions.length === 0) throw new LearningError(403, "FORBIDDEN");
  return new Set(fields);
}

function authorizeRead(recovered: Recovered & { activity: ReadingActivity; scope: Omit<ReviewScope, "delivery"> }, delivery: ReviewedDelivery,
  authorize: AuthorizeReview | undefined) {
  const fields = requireReviewPolicy(recovered.activity);
  if (authorize?.({ ...recovered.scope, delivery, purpose: "readReview" }) !== true) throw new LearningError(403, "FORBIDDEN");
  return fields;
}

function authorizedDelivery(
  database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey, authorize: AuthorizeReview | undefined,
) {
  const recovered = reviewConfirmation(database, reviewerId, activityId, key);
  const content = readQuestionDelivery(recovered.content);
  if (!content) throw new LearningError(404, "REVIEW_NOT_FOUND");
  return { ...recovered, content, fields: authorizeRead(recovered, "questionDelivery", authorize) };
}

function projectAnswers<T extends Confirmed>(confirmation: T, fields: Fields): T {
  if (fields.has("studentChoices")) return confirmation;
  return { ...confirmation, questions: confirmation.questions.map(({ value: _value, choice: _choice, ...question }) => question) };
}

function reviewedDelivery({ practice: { id, version } }: ReadingActivity, receipt: SubmissionReceipt, content: QuestionDelivery, fields: Fields) {
  return { receipt, practice: { id, version }, confirmation: projectAnswers(questionDeliveryView(content), fields) };
}

function manualBasis(database: DatabaseSync, receipt: SubmissionReceipt, keyRef: { id: string; version: number }, fields: Fields) {
  return fields.has("gradingBasis") ? { basis: readManualReviewBasis(database, receipt, keyRef) } : {};
}

function requireAssessment(database: DatabaseSync, submissionId: string, targetId: string) {
  const target = submissionReviewTarget(database, submissionId, targetId);
  if (!target) throw new LearningError(404, "REVIEW_NOT_FOUND");
  return target;
}

function reviewConfirmation(database: DatabaseSync, reviewerId: string, activityId: string, key: ConfirmationKey) {
  const { stepAttemptId, operationId } = key;
  const studentId = database.prepare(`
    SELECT a.student_id AS studentId FROM activities a
    JOIN step_attempts t ON t.activity_id = a.id
    LEFT JOIN reading_reviews r ON r.activity_id = a.id
    WHERE a.id = ? AND t.id = ? AND (r.activity_id IS NULL OR (r.reviewer_id = ? AND r.reviewer_active = 1))
  `).get(activityId, stepAttemptId, reviewerId)?.studentId;
  if (typeof studentId !== "string") throw new LearningError(403, "FORBIDDEN");
  const activity = loadActivity(database, studentId, activityId);
  if (activity.kind !== "reading" || activity.stepAttemptId !== stepAttemptId) throw new LearningError(403, "FORBIDDEN");
  const recovered = confirmedWorkForOperation(database, activityId, key);
  if (!recovered) throw new LearningError(403, "FORBIDDEN");
  const { id: submissionId, slotId } = recovered.receipt;
  const scope = { reviewerId, studentId, activityId, stepAttemptId, operationId, submissionId, slotId };
  return { activity, ...recovered, scope };
}
