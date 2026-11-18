import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { activityAutomaticVerdicts } from "./evaluation.ts";
import { LearningError } from "./learning-error.ts";
import { findSource } from "./reading-answers.ts";
import { readingSubmissionView } from "./reading-progress.ts";
import { activitySubmissions } from "./submission-store.ts";

export const selectionFeedbackInput = z.strictObject({
  protocolVersion: z.literal(1),
  text: z.string().trim().min(1).max(5000),
});
const assignment = z.strictObject({ studentId: z.string(), feedback: z.string().nullable() });

function requireReview(database: DatabaseSync, reviewer: string, activityId: string) {
  const found = database.prepare(`
    SELECT a.student_id AS studentId, r.selection_feedback AS feedback
    FROM reading_reviews r JOIN activities a ON a.id = r.activity_id
    WHERE a.id = ? AND r.reviewer_id = ?
  `).get(activityId, reviewer);
  if (!found) throw new LearningError(403, "FORBIDDEN");
  const row = assignment.parse(found);
  const activity = loadActivity(database, row.studentId, activityId);
  if (activity.kind !== "reading") throw new LearningError(403, "FORBIDDEN");
  return { activity, feedback: row.feedback };
}

export function readReview(database: DatabaseSync, reviewer: string, activityId: string) {
  const { activity, feedback } = requireReview(database, reviewer, activityId);
  const fields = new Set(activity.practice.policy.reviewer.fields);
  const submissions = activitySubmissions(database, activityId).map(readingSubmissionView).filter(submission =>
    submission.selection ? fields.has("submittedQuotes") : fields.has("studentChoices"));
  const automaticVerdicts = fields.has("gradingBasis") ? activityAutomaticVerdicts(database, activityId) : [];
  return {
    activityId, submissions,
    automaticVerdicts: automaticVerdicts.length ? automaticVerdicts : undefined,
    selectionFeedback: fields.has("learnerFeedback") ? feedback : undefined,
  };
}

export function writeSelectionFeedback(database: DatabaseSync, reviewer: string, activityId: string, text: string) {
  return writeTransaction(database, () => {
    const { activity } = requireReview(database, reviewer, activityId);
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
