import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

export const managementInput = z.strictObject({
  protocolVersion: z.literal(1),
  action: z.enum(["openReview", "closeReview", "revokeReviewer", "revokeStudent", "authorizeRedo"]),
});

const disclosure = z.strictObject({
  reviewOpen: z.literal([0, 1]).transform(Boolean),
  feedback: z.string().nullable(),
});
const teacherAssignment = z.strictObject({
  studentId: z.string(), feedback: z.string().nullable(), reviewerActive: z.literal([0, 1]).transform(Boolean),
});

export function reviewDisclosure(database: DatabaseSync, activityId: string) {
  const row = database.prepare(`
    SELECT review_open AS reviewOpen, selection_feedback AS feedback FROM reading_reviews WHERE activity_id = ?
  `).get(activityId);
  return row ? disclosure.parse(row) : undefined;
}

export function assignedReading(database: DatabaseSync, teacher: string, activityId: string, role: "reviewer" | "manager") {
  const found = database.prepare(`
    SELECT a.student_id AS studentId, r.selection_feedback AS feedback, r.reviewer_active AS reviewerActive
    FROM activities a JOIN reading_reviews r ON a.id = r.activity_id
    WHERE a.id = ? AND r.reviewer_id = ?
  `).get(activityId, teacher);
  if (!found) throw new LearningError(403, "FORBIDDEN");
  const { studentId, feedback, reviewerActive } = teacherAssignment.parse(found);
  if (role === "reviewer" && !reviewerActive) throw new LearningError(403, "FORBIDDEN");
  const activity = loadActivity(database, studentId, activityId);
  if (activity.kind !== "reading") throw new LearningError(403, "FORBIDDEN");
  return { activity, feedback, reviewerActive };
}

export function managementView(database: DatabaseSync, teacher: string, activityId: string) {
  const { activity, reviewerActive } = assignedReading(database, teacher, activityId, "manager");
  const reviewOpen = reviewDisclosure(database, activityId)?.reviewOpen ?? false;
  return {
    reviewOpen,
    canToggleReview: activity.practice.policy.manager.actions.includes(reviewOpen ? "closeReview" : "openReview"),
    reviewerActions: reviewerActive ? activity.practice.policy.reviewer.actions : [],
  };
}

export function manageReading(
  database: DatabaseSync, teacher: string, activityId: string, action: z.infer<typeof managementInput>["action"],
) {
  return writeTransaction(database, () => {
    const { activity } = assignedReading(database, teacher, activityId, "manager");
    if (action === "revokeReviewer") {
      database.prepare("UPDATE reading_reviews SET reviewer_active = 0 WHERE activity_id = ?").run(activityId);
      return { reviewerActive: false };
    }
    if (action === "revokeStudent") {
      database.prepare("UPDATE reading_reviews SET student_active = 0 WHERE activity_id = ?").run(activityId);
      return { studentActive: false };
    }
    if (!activity.practice.policy.manager.actions.includes(action)) throw new LearningError(403, "FORBIDDEN");
    if (action === "authorizeRedo") {
      if (!activity.completed) throw new LearningError(409, "REDO_NOT_AVAILABLE");
      database.prepare("UPDATE reading_reviews SET redo_authorized = 1 WHERE activity_id = ?").run(activityId);
      return { redoAuthorized: true };
    }
    const reviewOpen = action === "openReview";
    database.prepare("UPDATE reading_reviews SET review_open = ? WHERE activity_id = ?").run(Number(reviewOpen), activityId);
    return { reviewOpen };
  });
}
