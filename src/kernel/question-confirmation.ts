import type { DatabaseSync } from "node:sqlite";
import type {
  AuthorizeConfirmationRecovery, ChoiceConfirmation, ChoiceConfirmationInput, ConfirmationKey,
  ConfirmationScope, VerifyOriginal,
} from "../contracts/choice-confirmation.ts";
import { hasStoredResponse, sameStoredResponse } from "../contracts/response.ts";
import type { IndexResponseConfirmation, ResponseConfirmation, StoredResponseValue } from "../contracts/response.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import type { ReadingActivity } from "./activity.ts";
import { queueEvaluation } from "./evaluation.ts";
import { LearningError } from "./learning-error.ts";
import { finishActivity, recordSubmission, submissionForOperation } from "./submission-store.ts";
import { loadWorkVersion, saveWorkVersion } from "./work-versions.ts";

type QuestionRevision = ChoiceConfirmationInput["questions"][number];
type ConfirmedValue<Key extends "choice" | "value"> = Pick<QuestionRevision, "revision" | "questionVersion">
  & Record<Key, StoredResponseValue | null>;

export function confirmedDraftChangeCount<Key extends "choice" | "value">(
  question: ConfirmedValue<Key>, draft: (ConfirmedValue<Key> & { changeCount: number }) | undefined, field: Key,
) {
  if (question[field] === null) return 0;
  if (draft?.revision !== question.revision || !sameStoredResponse(draft[field], question[field]) || draft.questionVersion !== question.questionVersion) {
    throw new Error("已确认作答缺少对应的草稿版本");
  }
  return draft.changeCount;
}

export function requireConfirmationRecovery(scope: ConfirmationScope, authorize?: AuthorizeConfirmationRecovery) {
  if (authorize?.(scope) !== true) throw new LearningError(403, "FORBIDDEN");
}

export function mapConfirmationQuestions<T>(
  activity: ReadingActivity, revisions: readonly QuestionRevision[], project: (question: QuestionRevision) => T,
) {
  const frozen = activity.practice.questions;
  const selected = new Map(revisions.map(question => [question.questionId, question]));
  if (selected.size !== frozen.length || selected.size !== revisions.length) {
    throw new LearningError(422, "INVALID_QUESTION_SET");
  }
  return frozen.map(question => {
    const requested = selected.get(question.id);
    if (!requested) throw new LearningError(422, "INVALID_QUESTION_SET");
    if (requested.questionVersion !== question.version) throw new LearningError(409, "QUESTION_REVISION_STALE");
    return project(requested);
  });
}

export function writeQuestionConfirmation(
  database: DatabaseSync, activity: ReadingActivity, studentId: string, input: ChoiceConfirmationInput, targetId: string,
  content: ChoiceConfirmation | ResponseConfirmation | IndexResponseConfirmation, now: Date, verify?: VerifyOriginal,
) {
  const { activityId } = activity;
  const { stepAttemptId, slotId, operationId } = input;
  for (const { questionId, questionVersion, original } of content.questions) {
    if (!verify && original.state === "uncollected") continue;
    if (verify?.({ studentId, activityId, stepAttemptId, slotId, operationId, questionId, questionVersion, original: { ...original } }) !== true) {
      throw new LearningError(409, "ORIGINAL_NOT_VERIFIED");
    }
  }
  const draft = saveWorkVersion(database, workScope(activityId, stepAttemptId, slotId), content);
  const observations = content.questions.flatMap(question => hasStoredResponse("choice" in question ? question.choice : question.value)
    ? [{ targetId, unitId: `question:${question.questionId}` }] : []);
  const receipt = recordSubmission(database, { ...input, draft }, observations, now);
  queueEvaluation(database, activity, receipt, targetId);
  finishActivity(database, activityId, receipt.id);
  return receipt;
}

export function confirmedWorkForOperation(database: DatabaseSync, activityId: string, input: ConfirmationKey) {
  const previous = submissionForOperation(database, input);
  if (!previous) return undefined;
  const { receipt, draft } = previous;
  return { receipt, content: loadWorkVersion(database, workScope(activityId, receipt.stepAttemptId, receipt.slotId), draft) };
}

export function replayQuestionConfirmation(receipt: SubmissionReceipt, intent: QuestionRevision[] | undefined, input: ChoiceConfirmationInput) {
  if (receipt.slotId !== input.slotId || !intent || questionIntent(intent) !== questionIntent(input.questions)) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return receipt;
}

function questionIntent(questions: ChoiceConfirmationInput["questions"]) {
  return JSON.stringify(questions.toSorted((a, b) => a.questionId === b.questionId ? 0 : a.questionId < b.questionId ? -1 : 1));
}

function workScope(activityId: string, stepAttemptId: string, slotId: string) {
  return { activityId, step: { id: stepAttemptId, slotId } };
}
