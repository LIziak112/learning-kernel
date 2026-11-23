import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { preparedVersionIntent, preparedVersionReceipt } from "../contracts/prepared-activity.ts";
import type { PreparedActivityVersionInput } from "../contracts/prepared-activity.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import { loadStudentActivity } from "./activity.ts";
import type { ReadingActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { rebindQuestionDeliveryDrafts } from "./question-delivery-mode-switch.ts";

const storedChange = preparedVersionReceipt.pick({ stepAttemptId: true, practiceVersion: true }).extend({
  fromStepAttemptId: z.uuid(), fromPracticeVersion: z.int().positive(), intent: preparedVersionIntent.nullable(),
});
const storedPractice = z.object({ definition: z.string() });

export function replacePreparedActivityVersion(database: DatabaseSync, student: string, activityId: string, input: PreparedActivityVersionInput) {
  return writeTransaction(database, () => {
    const activity = loadStudentActivity(database, student, activityId);
    if (activity.kind !== "reading" || activity.practiceVersion === undefined) throw new LearningError(409, "ACTIVITY_NOT_PREPARED");
    const previous = recoverVersionChange(database, activityId, input);
    if (previous) return { activityId, startedAt: activity.startedAt, ...previous };
    if (activity.stepAttemptId !== input.stepAttemptId || activity.practiceVersion !== input.expectedPracticeVersion) {
      throw new LearningError(409, "ACTIVITY_VERSION_CONFLICT");
    }
    const { practiceVersion, intent } = input;
    requireNoLearningFacts(database, activityId, intent === "questionDeliveryMode");
    const stepAttemptId = rebindVersion(database, activity, practiceVersion, intent);
    database.prepare(`
      INSERT INTO prepared_activity_version_changes (
        activity_id, operation_id, from_step_attempt_id, from_practice_version, step_attempt_id, practice_version, intent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(activityId, input.operationId, input.stepAttemptId, input.expectedPracticeVersion, stepAttemptId, practiceVersion, intent ?? null);
    return { activityId, startedAt: activity.startedAt, stepAttemptId, practiceVersion };
  });
}

function recoverVersionChange(database: DatabaseSync, activityId: string, input: PreparedActivityVersionInput) {
  const row = database.prepare(`
    SELECT from_step_attempt_id AS fromStepAttemptId, from_practice_version AS fromPracticeVersion,
      step_attempt_id AS stepAttemptId, practice_version AS practiceVersion, intent
    FROM prepared_activity_version_changes WHERE activity_id = ? AND operation_id = ?
  `).get(activityId, input.operationId);
  if (!row) return undefined;
  const { fromStepAttemptId, fromPracticeVersion, stepAttemptId, practiceVersion, intent } = storedChange.parse(row);
  if (fromStepAttemptId !== input.stepAttemptId || fromPracticeVersion !== input.expectedPracticeVersion
    || practiceVersion !== input.practiceVersion || intent !== (input.intent ?? null)) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return { stepAttemptId, practiceVersion };
}

function requireNoLearningFacts(database: DatabaseSync, activityId: string, allowQuestionDrafts: boolean) {
  const used = database.prepare(`
    SELECT 1
    WHERE (? = 0 AND EXISTS (SELECT 1 FROM works WHERE activity_id = ?))
       OR EXISTS (SELECT 1 FROM completions WHERE activity_id = ?)
       OR EXISTS (
         SELECT 1 FROM choice_snapshot_revisions r JOIN step_attempts s ON s.id = r.step_attempt_id
         WHERE s.activity_id = ?
       )
       OR EXISTS (SELECT 1 FROM step_attempts WHERE activity_id = ? AND ordinal > 0)
       OR EXISTS (
         SELECT 1 FROM submissions JOIN step_attempts ON submissions.step_attempt_id = step_attempts.id
         WHERE step_attempts.activity_id = ?
       )
  `).get(Number(allowQuestionDrafts), activityId, activityId, activityId, activityId, activityId);
  if (used) throw new LearningError(409, "ACTIVITY_ALREADY_STARTED");
}

function rebindVersion(
  database: DatabaseSync, activity: ReadingActivity, practiceVersion: number, intent: PreparedActivityVersionInput["intent"],
) {
  if (intent === undefined && practiceVersion === activity.practiceVersion) return activity.stepAttemptId;
  const row = database.prepare("SELECT definition FROM practices WHERE id = ? AND version = ?").get(activity.practice.id, practiceVersion);
  if (!row) throw new LearningError(404, "PRACTICE_NOT_FOUND");
  const published = readingPracticeSchema.safeParse(JSON.parse(storedPractice.parse(row).definition));
  if (!published.success || published.data.steps[0].id !== activity.step.id) throw new LearningError(409, "PREPARED_STEP_CHANGED");
  const stepAttemptId = randomUUID();
  if (intent === "questionDeliveryMode") rebindQuestionDeliveryDrafts(database, activity, published.data, stepAttemptId);
  database.prepare("UPDATE activities SET practice_version = ? WHERE id = ?").run(practiceVersion, activity.activityId);
  database.prepare("UPDATE step_attempts SET id = ? WHERE id = ? AND activity_id = ?").run(stepAttemptId, activity.stepAttemptId, activity.activityId);
  return stepAttemptId;
}
