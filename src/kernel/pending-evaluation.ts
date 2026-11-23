import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { VerdictResult } from "../contracts/evaluator.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { questionDeliveryScoringKey, readQuestionDelivery } from "../contracts/question-delivery.ts";
import { readingPracticeSchema, wholePaperScoringKey } from "../contracts/reading-publication.ts";
import { readingAnswer } from "../contracts/reading-runtime.ts";
import { readResponseConfirmation } from "../contracts/response.ts";
import { revisedChoiceKey } from "./choice-snapshot-store.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { recordEvaluation } from "./evaluation.ts";
import { confirmedDeliveryAssessment } from "./question-delivery-evaluation.ts";
import { evaluateFrozenAnswers, judgedOnly } from "./question-evaluation.ts";
import type { FrozenAnswer, QuestionKey } from "./question-evaluation.ts";
import { frozenResponseType, wholePaperQuestionKey } from "./question-types.ts";
import type { Registry } from "./registry.ts";
import { recordResponseReviewRequirements } from "./response-evaluation.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";

export const maxEvaluationAttempts = 3;

const pendingTask = z.strictObject({
  submissionId: z.uuid(), targetId: z.string(), activityId: z.uuid(), stepAttemptId: z.uuid(), slotId: z.string(),
  keyJSON: z.string(), practiceJSON: z.string(), contentJSON: z.string(),
});
type PendingTask = z.infer<typeof pendingTask>;
type Practice = z.infer<typeof readingPracticeSchema>;
type Outcome = { questionId: string; result: VerdictResult };

export type EvaluationSummary = { evaluated: number; retrying: number; failed: number; deferred: number };

function pendingTasks(database: DatabaseSync, submissionId?: string) {
  return database.prepare(`
    SELECT t.submission_id AS submissionId, t.target_id AS targetId, a.activity_id AS activityId, a.id AS stepAttemptId,
      s.slot_id AS slotId, k.definition AS keyJSON, p.definition AS practiceJSON, v.selection AS contentJSON
    FROM evaluation_tasks t
    JOIN scoring_keys k ON k.id = t.key_id AND k.version = t.key_version
    JOIN submissions s ON s.id = t.submission_id
    JOIN step_attempts a ON a.id = s.step_attempt_id
    JOIN activities i ON i.id = a.activity_id
    JOIN practices p ON p.id = i.practice_id AND p.version = i.practice_version
    JOIN work_versions v ON v.work_id = s.work_id AND v.version = s.work_version
    WHERE t.status = 'pending' AND (? IS NULL OR t.submission_id = ?) ORDER BY s.confirmed_at, s.id
  `).all(submissionId ?? null, submissionId ?? null).map(row => pendingTask.parse(row));
}

export function evaluatePending(
  database: DatabaseSync, registry: Registry, checkpoint?: RuntimeCheckpoint, submissionId?: string,
): EvaluationSummary {
  const summary: EvaluationSummary = { evaluated: 0, retrying: 0, failed: 0, deferred: 0 };
  for (const task of readTransaction(database, () => pendingTasks(database, submissionId))) {
    checkpoint?.({ point: "beforeEvaluation", submissionId: task.submissionId });
    let outcomes: Outcome[] | undefined;
    try {
      outcomes = readTransaction(database, () => evaluateTask(database, registry, task));
    } catch (error) {
      if (error instanceof LearningError && error.status === 503) {
        summary.deferred++;
      } else {
        const status = recordFailure(database, task, failureCode(error));
        if (status === "failed") summary.failed++;
        else if (status === "pending") summary.retrying++;
      }
      continue;
    }
    if (outcomes && writeTransaction(database, () => completeTask(database, task, outcomes, checkpoint))) summary.evaluated++;
  }
  return summary;
}

function evaluateTask(database: DatabaseSync, registry: Registry, task: PendingTask): Outcome[] | undefined {
  const practice = readingPracticeSchema.parse(JSON.parse(task.practiceJSON));
  const assessment = practice.grading.assessment;
  if (!assessment) return undefined;
  const content: unknown = JSON.parse(task.contentJSON);
  const key: unknown = JSON.parse(task.keyJSON);
  const context = { activityId: task.activityId, stepAttemptId: task.stepAttemptId, slotId: task.slotId,
    practice: { id: practice.id, version: practice.version } };
  const frozen = frozenAnswers(database, registry, practice, task, content, key);
  if (!frozen) return undefined;
  const outcomes = evaluateFrozenAnswers(registry, practice, assessment.evaluator, context, frozen.answers, frozen.keyOf);
  return frozen.judgedOnly ? judgedOnly(outcomes).map(({ questionId, correct }) => ({ questionId, result: { status: "judged", correct } })) : outcomes;
}

type Frozen = { answers: FrozenAnswer[]; keyOf: QuestionKey; judgedOnly: boolean };

function frozenAnswers(
  database: DatabaseSync, registry: Registry, practice: Practice, task: PendingTask, content: unknown, key: unknown,
): Frozen | undefined {
  const wholeKey = (question: Practice["questions"][number]) =>
    wholePaperQuestionKey(wholePaperScoringKey.parse(key), frozenResponseType(registry, practice, question), question);
  const delivery = readQuestionDelivery(content);
  if (delivery) {
    const { automatic } = confirmedDeliveryAssessment({ practice }, delivery);
    if (!automatic.length) return undefined;
    const { acceptedByQuestion } = questionDeliveryScoringKey.parse(key);
    return { answers: automatic, judgedOnly: false, keyOf: question => {
      const entry = Object.hasOwn(acceptedByQuestion, question.id) ? acceptedByQuestion[question.id] : undefined;
      if (!entry || entry.response !== question.response) return undefined;
      const { response, ...questionKey } = entry;
      return registry.requireResponseType(response).parseKey?.(questionKey, question);
    } };
  }
  const choices = readChoiceConfirmation(content);
  if (choices) {
    const versions = new Map(choices.questions.map(({ questionId, questionVersion }) => [questionId, questionVersion]));
    return {
      answers: choices.questions.map(({ questionId, questionVersion, choice }) => ({ questionId, questionVersion, value: choice })),
      judgedOnly: true,
      keyOf: question => {
        const revised = revisedChoiceKey(database, { ...task, questionId: question.id }, versions.get(question.id) ?? 0);
        return revised === undefined ? wholeKey(question) : { acceptedChoice: revised };
      },
    };
  }
  const responses = readResponseConfirmation(content);
  if (responses) return { answers: responses.questions, judgedOnly: false, keyOf: wholeKey };
  const answer = readingAnswer.parse(content);
  return {
    answers: practice.questions.map(({ id, version }) => ({ questionId: id, questionVersion: version ?? 1, value: answer.choices[id] ?? null })),
    judgedOnly: true, keyOf: wholeKey,
  };
}

function stillPending(database: DatabaseSync, submissionId: string) {
  return Boolean(database.prepare("SELECT 1 FROM evaluation_tasks WHERE submission_id = ? AND status = 'pending'").get(submissionId));
}

function completeTask(database: DatabaseSync, task: PendingTask, outcomes: readonly Outcome[], checkpoint?: RuntimeCheckpoint) {
  if (!stillPending(database, task.submissionId)) return false;
  const pending = outcomes.flatMap(({ questionId, result }) => result.status === "needsReview" ? [questionId] : []);
  const judged = outcomes.flatMap(({ questionId, result }) => result.status === "judged" ? [{ questionId, correct: result.correct }] : []);
  recordResponseReviewRequirements(database, task.submissionId, pending);
  recordEvaluation(database, task, judged, checkpoint);
  return true;
}

function failureCode(error: unknown) {
  if (error instanceof LearningError) return error.code;
  if (error instanceof z.ZodError) return "INVALID_EVALUATOR_RESULT";
  return "EVALUATOR_FAILED";
}

function recordFailure(database: DatabaseSync, task: PendingTask, code: string) {
  return writeTransaction(database, () => {
    if (!stillPending(database, task.submissionId)) return undefined;
    database.prepare(`
      UPDATE evaluation_tasks SET attempts = attempts + 1, last_error = ?,
        status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE submission_id = ? AND status = 'pending'
    `).run(code, maxEvaluationAttempts, task.submissionId);
    return z.enum(["pending", "failed"]).parse(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?")
      .get(task.submissionId)?.status);
  });
}
