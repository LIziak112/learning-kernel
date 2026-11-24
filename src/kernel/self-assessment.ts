import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ConfirmationKey } from "../contracts/choice-confirmation.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { orderedQuestionValues, readQuestionDelivery } from "../contracts/question-delivery.ts";
import { selfAssessmentRubric, selfAssessmentVerdict } from "../contracts/self-assessment.ts";
import type { SelfAssessmentInput, SelfAssessmentReceipt, SelfAssessmentScoring } from "../contracts/self-assessment.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { readTransaction, writeTransaction } from "./database.ts";
import { confirmedWorkForOperation } from "./question-confirmation.ts";
import { requireQuestionDeliverySlot } from "./question-delivery-drafts.ts";
import { questionVerdictStates, submissionReviewTarget } from "./verdict-state.ts";

const storedEvent = z.strictObject({
  id: z.uuid(),
  submissionId: z.uuid(),
  questionId: z.string(),
  revision: z.int().positive(),
  verdict: selfAssessmentVerdict.nullable(),
  rubric: z.string().nullable(),
  assessedAt: z.iso.datetime(),
});
const eventFields = "id, submission_id AS submissionId, question_id AS questionId, revision, verdict, rubric, assessed_at AS assessedAt";

type Rubric = z.infer<typeof selfAssessmentRubric>;
type Event = Omit<z.infer<typeof storedEvent>, "rubric"> & { rubric?: Rubric };
type Verdict = Event["verdict"];
type Delivered = Readonly<{ questionId: string; questionVersion: number }>;
export type SelfCountEntry = Readonly<{ effective?: { correct: boolean }; self: Verdict }>;

function parseEvent(row: unknown): Event {
  const { rubric, ...event } = storedEvent.parse(row);
  return rubric === null ? event : { ...event, rubric: selfAssessmentRubric.parse(JSON.parse(rubric)) };
}

export function selfAssessmentScoring(activity: Pick<ReadingActivity, "practice">): SelfAssessmentScoring | undefined {
  return activity.practice.policy.student.selfAssessment?.scoring;
}

export function selfReviewQuestionIds(activity: Pick<ReadingActivity, "practice">): ReadonlySet<string> {
  return new Set(activity.practice.policy.student.selfAssessment ? activity.practice.grading.selfReview?.questionIds : []);
}

export function currentSelfAssessments(database: DatabaseSync, submissionId: string) {
  const current = new Map<string, Event>();
  const rows = database.prepare(`SELECT ${eventFields} FROM self_assessment_events WHERE submission_id = ? ORDER BY revision`).all(submissionId);
  for (const event of rows.map(parseEvent)) current.set(event.questionId, event);
  return current;
}

export type SelfAssessmentView = ReturnType<typeof selfAssessmentView>;

export function selfAssessmentView(event: Event | undefined) {
  if (!event) return { source: "self" as const, revision: 0, verdict: null };
  const { verdict, rubric, revision, assessedAt } = event;
  return { source: "self" as const, revision, verdict, ...rubric && { rubric }, assessedAt };
}

export function selfAssessmentCounts(scoring: SelfAssessmentScoring, entries: readonly SelfCountEntry[]) {
  const counts = { questionCount: entries.length, judgedCorrect: 0, judgedWrong: 0, selfAssessedCorrect: 0, selfAssessedWrong: 0, pending: 0 };
  for (const { effective, self } of entries) {
    if (effective) counts[effective.correct ? "judgedCorrect" : "judgedWrong"]++;
    else if (self) counts[self === "correct" ? "selfAssessedCorrect" : "selfAssessedWrong"]++;
    else counts.pending++;
  }
  const correctCount = counts.judgedCorrect + (scoring === "countAsCorrect" ? counts.selfAssessedCorrect : 0);
  return { scoring, ...counts, correctCount };
}

export function readSelfAssessments(database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey) {
  return readTransaction(database, () => {
    const { activity, receipt, content } = studentDelivery(database, studentId, activityId, key);
    const scoring = selfAssessmentScoring(activity);
    if (!scoring) throw new LearningError(409, "SELF_ASSESSMENT_NOT_AVAILABLE");
    return { submissionId: receipt.id, scoring, questions: deliveredSelfAssessments(database, activity, receipt.id, content.questions) };
  });
}

export function deliveredSelfAssessments(database: DatabaseSync, activity: ReadingActivity, submissionId: string, questions: readonly Delivered[]) {
  const routed = selfReviewQuestionIds(activity);
  const current = currentSelfAssessments(database, submissionId);
  return questions.filter(({ questionId }) => routed.has(questionId))
    .map(({ questionId, questionVersion }) => ({ questionId, questionVersion, selfAssessment: selfAssessmentView(current.get(questionId)) }));
}

export function assessSelf(
  database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey, input: SelfAssessmentInput, clock: () => Date,
): SelfAssessmentReceipt {
  return writeTransaction(database, () => {
    const { activity, receipt, content } = studentDelivery(database, studentId, activityId, key);
    if (!content.questions.some(({ questionId }) => questionId === input.questionId)) throw new LearningError(403, "FORBIDDEN");
    const replayed = database.prepare(`SELECT ${eventFields} FROM self_assessment_events WHERE activity_id = ? AND operation_id = ?`)
      .get(activityId, input.operationId);
    if (replayed) return replay(database, parseEvent(replayed), receipt.id, input);
    requireSelfAssessable(database, activity, receipt.id, content.slotId, input.questionId);
    const current = currentSelfAssessments(database, receipt.id).get(input.questionId);
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new LearningError(409, "SELF_ASSESSMENT_CONFLICT");
    const rubric = nextRubric(current, input);
    const event = { id: randomUUID(), submissionId: receipt.id, questionId: input.questionId, revision: input.expectedRevision + 1 };
    database.prepare(`
      INSERT INTO self_assessment_events (id, activity_id, submission_id, question_id, revision, operation_id, verdict, rubric, assessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, activityId, event.submissionId, event.questionId, event.revision, input.operationId, input.verdict,
      rubric ? JSON.stringify(rubric) : null, clock().toISOString());
    return { ...event, verdict: input.verdict, ...rubric && { rubric } };
  });
}

function studentDelivery(database: DatabaseSync, studentId: string, activityId: string, key: ConfirmationKey) {
  const activity = loadStudentReadingActivity(database, studentId, activityId, key.stepAttemptId);
  const recovered = confirmedWorkForOperation(database, activityId, key);
  const content = recovered && readQuestionDelivery(recovered.content);
  if (!recovered || !content) throw new LearningError(404, "CONFIRMATION_NOT_FOUND");
  return { activity, receipt: recovered.receipt, content };
}

function nextRubric(current: Event | undefined, input: SelfAssessmentInput): Rubric | undefined {
  if (input.rubric === undefined) return current?.rubric;
  return Object.keys(input.rubric).length > 0 ? orderedQuestionValues(input.rubric) : undefined;
}

function replay(database: DatabaseSync, event: Event, submissionId: string, input: SelfAssessmentInput): SelfAssessmentReceipt {
  const previous = database.prepare(`
    SELECT ${eventFields} FROM self_assessment_events WHERE submission_id = ? AND question_id = ? AND revision = ?
  `).get(event.submissionId, event.questionId, event.revision - 1);
  const requested = nextRubric(previous ? parseEvent(previous) : undefined, input);
  if (event.submissionId !== submissionId || event.questionId !== input.questionId || event.revision !== input.expectedRevision + 1
    || event.verdict !== input.verdict || !isDeepStrictEqual(event.rubric, requested)) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  const { id, questionId, revision, verdict, rubric } = event;
  return { id, submissionId, questionId, revision, verdict, ...rubric && { rubric } };
}

function requireSelfAssessable(database: DatabaseSync, activity: ReadingActivity, submissionId: string, slotId: string, questionId: string) {
  if (!selfReviewQuestionIds(activity).has(questionId)) throw new LearningError(409, "SELF_ASSESSMENT_NOT_AVAILABLE");
  const target = submissionReviewTarget(database, submissionId, requireQuestionDeliverySlot(activity, slotId).targetId);
  if (!target) throw new LearningError(409, "SELF_ASSESSMENT_NOT_AVAILABLE");
  if (target.status === "pending") throw new LearningError(409, "EVALUATION_PENDING");
  const [state] = questionVerdictStates(database, target, [{ questionId }]);
  if (state?.effective?.source === "teacherReview") throw new LearningError(409, "SELF_ASSESSMENT_TEACHER_JUDGED");
  if (state?.effective) throw new LearningError(409, "SELF_ASSESSMENT_NOT_AVAILABLE");
}
