import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadStudentActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";

const changeTimes = z.strictObject({
  firstChangedAt: z.iso.datetime().nullable(),
  lastChangedAt: z.iso.datetime().nullable(),
});
const storedActivity = changeTimes.extend({ hasDraft: z.literal([0, 1]) });
const hasChoiceDraft = `EXISTS (
  SELECT 1 FROM step_attempts s JOIN works w ON w.step_attempt_id = s.id AND w.question_id IS NOT NULL
  WHERE s.activity_id = activities.id AND w.activity_id = activities.id
)`;

export type ChoiceDraftActivity = z.infer<typeof changeTimes>;

export function readChoiceDraftActivity(database: DatabaseSync, student: string, activityId: string): ChoiceDraftActivity | undefined {
  return writeTransaction(database, () => {
    loadStudentActivity(database, student, activityId);
    const { hasDraft, ...times } = storedActivity.parse(database.prepare(`
      SELECT first_choice_changed_at AS firstChangedAt, last_choice_changed_at AS lastChangedAt, ${hasChoiceDraft} AS hasDraft
      FROM activities WHERE id = ?
    `).get(activityId));
    return hasDraft ? times : undefined;
  });
}

export function recordChoiceDraftChange(database: DatabaseSync, activityId: string, changedAt: Date) {
  const timestamp = changedAt.toISOString();
  database.prepare(`
    UPDATE activities
    SET first_choice_changed_at = CASE WHEN ${hasChoiceDraft} THEN first_choice_changed_at ELSE ? END,
        last_choice_changed_at = ?
    WHERE id = ?
  `).run(timestamp, timestamp, activityId);
}
