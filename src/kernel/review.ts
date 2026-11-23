import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { VerdictCommand } from "../contracts/verdict.ts";
import type { ReadingActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { findSource } from "./reading-answers.ts";
import { readingSubmissionView } from "./reading-progress.ts";
import { assignedReading } from "./review-access.ts";
import { activitySubmissions } from "./submission-store.ts";
import { appendReview, eventView, repeatedReview } from "./verdict-history.ts";
import { assessmentTarget, questionVerdicts } from "./verdict-state.ts";

export const selectionFeedbackInput = z.strictObject({
  protocolVersion: z.literal(1),
  text: z.string().trim().min(1).max(5000),
});

export function readReview(database: DatabaseSync, reviewer: string, activityId: string) {
  const { activity, feedback } = assignedReading(database, reviewer, activityId, "reviewer");
  const fields = new Set(activity.practice.policy.reviewer.fields);
  const submissions = activitySubmissions(database, activityId).map(readingSubmissionView).filter(submission =>
    submission.selection ? fields.has("submittedQuotes") : fields.has("studentChoices"));
  return {
    activityId, submissions,
    ...reviewGrading(database, activity, fields, submissions),
    selectionFeedback: fields.has("learnerFeedback") ? feedback : undefined,
  };
}

function reviewGrading(
  database: DatabaseSync,
  activity: ReadingActivity,
  fields: ReadonlySet<string>,
  submissions: ReturnType<typeof readingSubmissionView>[],
) {
  const showBasis = fields.has("gradingBasis");
  const showHistory = fields.has("verdictHistory");
  if (!showBasis && !showHistory) return {};
  const target = assessmentTarget(database, activity.activityId);
  if (!target) return {};
  const states = questionVerdicts(database, activity, target);
  if (!states.some(state => state.automatic || state.history.length)) return {};
  const choices = submissions.find(item => item.receipt.id === target.submissionId)?.answer?.choices;
  const verdicts = projectVerdicts(states, { showBasis, showHistory, choices });
  return { verdicts, automaticVerdicts: automaticVerdictList(verdicts) };
}

function automaticVerdictList(verdicts: ReturnType<typeof projectVerdicts>) {
  const automaticVerdicts = verdicts.flatMap(({ submissionId, targetId, questionId, automatic }) =>
    automatic ? [{ submissionId, targetId, questionId, correct: automatic.correct }] : []);
  return automaticVerdicts.length ? automaticVerdicts : undefined;
}

function projectVerdicts(
  states: ReturnType<typeof questionVerdicts>,
  { showBasis, showHistory, choices }: { showBasis: boolean; showHistory: boolean; choices: Record<string, string> | undefined },
) {
  return states.map(({ history, revision, effective, automatic, prompt, ...location }) => ({
    ...location, revision, choice: choices?.[location.questionId],
    prompt: choices ? prompt : undefined,
    effective: showBasis ? effective : undefined,
    automatic: showBasis ? automatic : undefined,
    history: showHistory ? history.map(eventView) : undefined,
  }));
}

export function writeVerdict(
  database: DatabaseSync, reviewer: string, activityId: string, command: VerdictCommand, clock: () => Date,
) {
  return writeTransaction(database, () => {
    const { activity } = assignedReading(database, reviewer, activityId, "reviewer");
    if (!activity.practice.policy.reviewer.actions.includes("reviseQuestionVerdict")) {
      throw new LearningError(403, "FORBIDDEN");
    }
    const past = repeatedReview(database, activityId, reviewer, command);
    if (past) return past;
    requireVerdictTarget(database, activity, command);
    return appendReview(database, activityId, reviewer, command, clock);
  });
}

function requireVerdictTarget(database: DatabaseSync, activity: ReadingActivity, command: VerdictCommand) {
  const target = assessmentTarget(database, activity.activityId);
  if (target?.submissionId !== command.submissionId || target.targetId !== command.targetId
    || !activity.practice.questions.some(question => question.id === command.questionId)) {
    throw new LearningError(403, "FORBIDDEN");
  }
}

export function writeSelectionFeedback(database: DatabaseSync, reviewer: string, activityId: string, text: string) {
  return writeTransaction(database, () => {
    const { activity } = assignedReading(database, reviewer, activityId, "reviewer");
    if (!activity.practice.policy.reviewer.actions.includes("commentOnQuotes")) throw new LearningError(403, "FORBIDDEN");
    const binding = activity.practice.grading.selectionFeedback;
    if (!binding || !findSource(activitySubmissions(database, activityId), binding.from)) {
      throw new LearningError(409, "FEEDBACK_NOT_AVAILABLE");
    }
    database.prepare("UPDATE reading_reviews SET selection_feedback = ? WHERE activity_id = ? AND reviewer_id = ?")
      .run(text, activityId, reviewer);
    return { selectionFeedback: text };
  });
}
