import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { preparedVersionReceipt } from "../contracts/prepared-activity.ts";
import type { PreparedActivityVersionInput } from "../contracts/prepared-activity.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import { loadStudentActivity } from "./activity.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";

const storedChange = preparedVersionReceipt.pick({ stepAttemptId: true, practiceVersion: true }).extend({
  fromStepAttemptId: z.uuid(), fromPracticeVersion: z.int().positive(),
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
    requireNoLearningFacts(database, activityId);
    const { practiceVersion } = input;
    const stepAttemptId = practiceVersion === activity.practiceVersion ? activity.stepAttemptId
      : rebindVersion(database, activityId, activity.stepAttemptId, activity.practice.id, practiceVersion, activity.step.id);
    database.prepare(`
      INSERT INTO prepared_activity_version_changes (
        activity_id, operation_id, from_step_attempt_id, from_practice_version, step_attempt_id, practice_version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(activityId, input.operationId, input.stepAttemptId, input.expectedPracticeVersion, stepAttemptId, practiceVersion);
    return { activityId, startedAt: activity.startedAt, stepAttemptId, practiceVersion };
  });
}

function recoverVersionChange(database: DatabaseSync, activityId: string, input: PreparedActivityVersionInput) {
  const row = database.prepare(`
    SELECT from_step_attempt_id AS fromStepAttemptId, from_practice_version AS fromPracticeVersion,
      step_attempt_id AS stepAttemptId, practice_version AS practiceVersion
    FROM prepared_activity_version_changes WHERE activity_id = ? AND operation_id = ?
  `).get(activityId, input.operationId);
  if (!row) return undefined;
  const { fromStepAttemptId, fromPracticeVersion, stepAttemptId, practiceVersion } = storedChange.parse(row);
  if (fromStepAttemptId !== input.stepAttemptId || fromPracticeVersion !== input.expectedPracticeVersion || practiceVersion !== input.practiceVersion) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return { stepAttemptId, practiceVersion };
}

function requireNoLearningFacts(database: DatabaseSync, activityId: string) {
  const used = database.prepare(`
    SELECT 1
    WHERE EXISTS (SELECT 1 FROM works WHERE activity_id = ?)
       OR EXISTS (SELECT 1 FROM completions WHERE activity_id = ?)
       OR EXISTS (SELECT 1 FROM step_attempts WHERE activity_id = ? AND ordinal > 0)
       OR EXISTS (
         SELECT 1 FROM submissions JOIN step_attempts ON submissions.step_attempt_id = step_attempts.id
         WHERE step_attempts.activity_id = ?
       )
  `).get(activityId, activityId, activityId, activityId);
  if (used) throw new LearningError(409, "ACTIVITY_ALREADY_STARTED");
}

function rebindVersion(
  database: DatabaseSync, activityId: string, previousStepAttemptId: string, practiceId: string, practiceVersion: number, stepId: string,
) {
  const row = database.prepare("SELECT definition FROM practices WHERE id = ? AND version = ?").get(practiceId, practiceVersion);
  if (!row) throw new LearningError(404, "PRACTICE_NOT_FOUND");
  const published = readingPracticeSchema.safeParse(JSON.parse(storedPractice.parse(row).definition));
  if (!published.success || published.data.steps[0].id !== stepId) throw new LearningError(409, "PREPARED_STEP_CHANGED");
  const stepAttemptId = randomUUID();
  database.prepare("UPDATE activities SET practice_version = ? WHERE id = ?").run(practiceVersion, activityId);
  database.prepare("UPDATE step_attempts SET id = ? WHERE id = ? AND activity_id = ?").run(stepAttemptId, previousStepAttemptId, activityId);
  return stepAttemptId;
}
