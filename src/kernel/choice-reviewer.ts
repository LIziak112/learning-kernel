import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChoiceReviewerScope } from "../contracts/choice-amendment.ts";
import type { ChoiceDraftScope } from "../contracts/choice-draft.ts";
import { loadStudentReadingActivity } from "./activity.ts";
import { LearningError } from "./learning-error.ts";

const amendmentActor = z.strictObject({ studentId: z.string(), assignedReviewer: z.string().nullable(), reviewerActive: z.literal([0, 1]).nullable() });

export function requireChoiceReviewerActivity(
  database: DatabaseSync, reviewerId: string, activityId: string, question: ChoiceDraftScope,
  authorize: (scope: ChoiceReviewerScope) => boolean | undefined,
) {
  const row = database.prepare(`
    SELECT a.student_id AS studentId, r.reviewer_id AS assignedReviewer, r.reviewer_active AS reviewerActive
    FROM activities a LEFT JOIN reading_reviews r ON r.activity_id = a.id WHERE a.id = ?
  `).get(activityId);
  if (!row) throw new LearningError(403, "FORBIDDEN");
  const { studentId, assignedReviewer, reviewerActive } = amendmentActor.parse(row);
  if (assignedReviewer !== null && (assignedReviewer !== reviewerId || reviewerActive !== 1)) throw new LearningError(403, "FORBIDDEN");
  const { stepAttemptId, slotId, questionId, questionVersion } = question;
  const activity = loadStudentReadingActivity(database, studentId, activityId, stepAttemptId);
  const scope = { reviewerId, studentId, activityId, stepAttemptId, slotId, questionId, questionVersion };
  if (authorize(scope) !== true) throw new LearningError(403, "FORBIDDEN");
  return { activity, scope };
}
