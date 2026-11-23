import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import type { ReadingActivity } from "./activity.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";

const storedKey = z.object({ definition: z.string() });

export function queueEvaluation(
  database: DatabaseSync,
  activity: ReadingActivity,
  receipt: SubmissionReceipt,
  targetId: string, assessmentSlotId = receipt.slotId,
) {
  const { assessment, manualReview } = activity.practice.grading;
  if (assessment && (assessment.from.stepId !== activity.step.id || assessment.from.slotId !== assessmentSlotId)) return;
  const keyRef = assessment?.keyRef ?? manualReview?.keyRef;
  if (!keyRef) return;
  database.prepare(`
    INSERT INTO evaluation_tasks (submission_id, key_id, key_version, target_id, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(receipt.id, keyRef.id, keyRef.version, targetId);
}

export function loadEvaluationKey(database: DatabaseSync, submissionId: string): unknown {
  const stored = database.prepare(`
    SELECT k.definition FROM scoring_keys k
    JOIN evaluation_tasks t ON t.key_id = k.id AND t.key_version = k.version
    WHERE t.submission_id = ?
  `).get(submissionId);
  return JSON.parse(storedKey.parse(stored).definition);
}

export function recordEvaluation(
  database: DatabaseSync, { submissionId, targetId }: { submissionId: string; targetId: string },
  verdicts: readonly { questionId: string; correct: boolean }[], checkpoint?: RuntimeCheckpoint,
) {
  const record = database.prepare(`
    INSERT INTO automatic_verdicts (submission_id, target_id, question_id, correct)
    VALUES (?, ?, ?, ?) ON CONFLICT (submission_id, target_id, question_id) DO NOTHING
  `);
  for (const { questionId, correct } of verdicts) {
    record.run(submissionId, targetId, questionId, Number(correct));
    checkpoint?.({ point: "afterAutomaticVerdict", submissionId, questionId });
  }
  checkpoint?.({ point: "beforeEvaluationComplete", submissionId });
  database.prepare("UPDATE evaluation_tasks SET status = 'done' WHERE submission_id = ?").run(submissionId);
}
