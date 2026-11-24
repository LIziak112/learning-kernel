import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { LearningError } from "../contracts/learning-error.ts";
import type { RestartInput } from "../contracts/reading.ts";
import { readingPracticeSchema } from "../contracts/reading-publication.ts";
import type { ReadingPublication } from "../contracts/reading-publication.ts";
import { createActivity, loadStudentActivity, recoverStart } from "./activity.ts";
import { writeTransaction } from "./database.ts";

type Practice = ReadingPublication["practice"];
type Recovered = NonNullable<ReturnType<typeof recoverStart>>;

const storedRestart = z.strictObject({ sourceActivityId: z.uuid() });
const storedOpening = z.strictObject({ prepared: z.literal([0, 1]), reviewerId: z.string().nullable() });
const storedPractice = z.strictObject({ definition: z.string() });

export function restartActivity(database: DatabaseSync, student: string, sourceId: string, input: RestartInput, clock: () => Date) {
  return writeTransaction(database, () => {
    const source = loadStudentActivity(database, student, sourceId);
    const existing = recoverStart(database, student, input.operationId);
    if (existing) return replayRestart(database, existing, sourceId, input);
    if (source.kind !== "reading" || !allowsRestart(source.practice)) throw new LearningError(409, "RESTART_NOT_AVAILABLE");
    if (database.prepare("SELECT 1 FROM activity_restarts WHERE source_activity_id = ?").get(sourceId)) {
      throw new LearningError(409, "RESTART_STALE");
    }
    const practice = targetPractice(database, source.practice, input.practiceVersion ?? source.practice.version);
    const { prepared, reviewerId } = storedOpening.parse(database.prepare(`
      SELECT a.initial_prepared_step_attempt_id IS NOT NULL AS prepared, r.reviewer_id AS reviewerId
      FROM activities a LEFT JOIN reading_reviews r ON r.activity_id = a.id WHERE a.id = ?
    `).get(sourceId));
    const restartedAt = clock();
    const receipt = createActivity(database, student, practice, input.operationId, restartedAt, reviewerId ?? undefined, sourceId, prepared === 1);
    database.prepare(`
      INSERT INTO activity_restarts (activity_id, source_activity_id, source_status, restarted_at) VALUES (?, ?, ?, ?)
    `).run(receipt.activityId, sourceId, source.completed ? "completed" : "abandoned", restartedAt.toISOString());
    return receipt;
  });
}

function replayRestart(database: DatabaseSync, existing: Recovered, sourceId: string, input: RestartInput) {
  const row = database.prepare("SELECT source_activity_id AS sourceActivityId FROM activity_restarts WHERE activity_id = ?")
    .get(existing.receipt.activityId);
  const recorded = row && storedRestart.parse(row);
  if (recorded?.sourceActivityId !== sourceId
    || (input.practiceVersion !== undefined && input.practiceVersion !== existing.practiceVersion)) {
    throw new LearningError(409, "OPERATION_CONFLICT");
  }
  return existing.receipt;
}

function allowsRestart(practice: Practice) {
  return practice.policy.student.restart === "anytime";
}

function targetPractice(database: DatabaseSync, source: Practice, version: number) {
  const row = database.prepare("SELECT definition FROM practices WHERE id = ? AND version = ?").get(source.id, version);
  if (!row) throw new LearningError(404, "PRACTICE_NOT_FOUND");
  const practice = readingPracticeSchema.safeParse(JSON.parse(storedPractice.parse(row).definition));
  if (!practice.success || !allowsRestart(practice.data)) throw new LearningError(409, "RESTART_NOT_AVAILABLE");
  return practice.data;
}
