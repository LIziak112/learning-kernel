import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

export const reviewToggle = z.strictObject({
  protocolVersion: z.literal(1),
  action: z.enum(["openReview", "closeReview"]),
});

const disclosure = z.strictObject({
  reviewOpen: z.literal([0, 1]).transform(Boolean),
  feedback: z.string().nullable(),
});
const teacherAssignment = z.strictObject({ studentId: z.string(), feedback: z.string().nullable() });

export function reviewDisclosure(database: DatabaseSync, activityId: string) {
  const row = database.prepare(`
    SELECT review_open AS reviewOpen, selection_feedback AS feedback FROM reading_reviews WHERE activity_id = ?
  `).get(activityId);
  return row ? disclosure.parse(row) : undefined;
}

export function assignedReading(database: DatabaseSync, teacher: string, activityId: string) {
  const found = database.prepare(`
    SELECT a.student_id AS studentId, r.selection_feedback AS feedback
    FROM activities a JOIN reading_reviews r ON a.id = r.activity_id
    WHERE a.id = ? AND r.reviewer_id = ?
  `).get(activityId, teacher);
  if (!found) throw new LearningError(403, "FORBIDDEN");
  const { studentId, feedback } = teacherAssignment.parse(found);
  const activity = loadActivity(database, studentId, activityId);
  if (activity.kind !== "reading") throw new LearningError(403, "FORBIDDEN");
  return { activity, feedback };
}

export function toggleReview(
  database: DatabaseSync, teacher: string, activityId: string, action: z.infer<typeof reviewToggle>["action"],
) {
  return writeTransaction(database, () => {
    const { activity } = assignedReading(database, teacher, activityId);
    if (!activity.practice.policy.manager.actions.includes(action)) throw new LearningError(403, "FORBIDDEN");
    const reviewOpen = action === "openReview";
    database.prepare("UPDATE reading_reviews SET review_open = ? WHERE activity_id = ?").run(Number(reviewOpen), activityId);
    return { reviewOpen };
  });
}
