import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readingCapability } from "../builtins/reading-capabilities.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { readingPracticeSchema, scoringKeySchema } from "../contracts/reading-publication.ts";
import { readingAnswer } from "../contracts/reading-runtime.ts";
import type { ReadingActivity } from "./activity.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";

const task = z.strictObject({
  submissionId: z.uuid(),
  targetId: z.string(),
  keyJSON: z.string(),
  practiceJSON: z.string(),
  answerJSON: z.string(),
});

export function queueEvaluation(
  database: DatabaseSync,
  activity: ReadingActivity,
  receipt: SubmissionReceipt,
  targetId: string,
) {
  const { assessment } = activity.practice.grading;
  if (assessment.from.stepId !== activity.step.id || assessment.from.slotId !== receipt.slotId) return;
  database.prepare(`
    INSERT INTO evaluation_tasks (submission_id, key_id, key_version, target_id, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(receipt.id, assessment.keyRef.id, assessment.keyRef.version, targetId);
}

export function evaluatePending(database: DatabaseSync, checkpoint?: RuntimeCheckpoint) {
  const pending = database.prepare(`
    SELECT t.submission_id AS submissionId, t.target_id AS targetId, k.definition AS keyJSON,
      p.definition AS practiceJSON, v.selection AS answerJSON
    FROM evaluation_tasks t
    JOIN scoring_keys k ON k.id = t.key_id AND k.version = t.key_version
    JOIN submissions s ON s.id = t.submission_id
    JOIN step_attempts a ON a.id = s.step_attempt_id
    JOIN activities i ON i.id = a.activity_id
    JOIN practices p ON p.id = i.practice_id AND p.version = i.practice_version
    JOIN work_versions v ON v.work_id = s.work_id AND v.version = s.work_version
    WHERE t.status = 'pending' ORDER BY s.confirmed_at, s.id
  `).all();
  for (const row of pending) evaluateTask(database, task.parse(row), checkpoint);
}

function evaluateTask(database: DatabaseSync, input: z.infer<typeof task>, checkpoint?: RuntimeCheckpoint) {
  checkpoint?.({ point: "beforeEvaluation", submissionId: input.submissionId });
  const practice = readingPracticeSchema.parse(JSON.parse(input.practiceJSON));
  const evaluator = readingCapability(practice.grading.assessment.evaluator);
  if (evaluator?.audience !== "server") throw new Error("已发布评估器不可用");
  const key = scoringKeySchema.parse(JSON.parse(input.keyJSON));
  const answer = readingAnswer.parse(JSON.parse(input.answerJSON));
  const record = database.prepare(`
    INSERT INTO automatic_verdicts (submission_id, target_id, question_id, correct)
    VALUES (?, ?, ?, ?) ON CONFLICT (submission_id, target_id, question_id) DO NOTHING
  `);
  for (const question of practice.questions) {
    const correct = key.acceptedChoices[question.id] === answer.choices[question.id];
    record.run(input.submissionId, input.targetId, question.id, Number(correct));
    checkpoint?.({ point: "afterAutomaticVerdict", submissionId: input.submissionId, questionId: question.id });
  }
  checkpoint?.({ point: "beforeEvaluationComplete", submissionId: input.submissionId });
  database.prepare("UPDATE evaluation_tasks SET status = 'done' WHERE submission_id = ?").run(input.submissionId);
}

const storedVerdict = z.strictObject({
  submissionId: z.uuid(), targetId: z.string(), questionId: z.string(), correct: z.literal([0, 1]).transform(Boolean),
});

export function activityAutomaticVerdicts(database: DatabaseSync, activityId: string) {
  return database.prepare(`
    SELECT v.submission_id AS submissionId, v.target_id AS targetId, v.question_id AS questionId, v.correct
    FROM automatic_verdicts v
    JOIN submissions s ON s.id = v.submission_id
    JOIN step_attempts a ON a.id = s.step_attempt_id
    WHERE a.activity_id = ?
    ORDER BY a.ordinal, v.target_id, v.question_id
  `).all(activityId).map(row => storedVerdict.parse(row));
}

const counts = z.strictObject({ correctCount: z.int().nonnegative(), questionCount: z.int().nonnegative() });
const activityTask = z.object({ submission_id: z.uuid(), target_id: z.string(), status: z.enum(["pending", "done"]) });

export function assessmentView(database: DatabaseSync, activity: ReadingActivity) {
  const row = database.prepare(`
    SELECT t.submission_id, t.target_id, t.status
    FROM evaluation_tasks t JOIN completions c ON c.submission_id = t.submission_id
    WHERE c.activity_id = ?
  `).get(activity.activityId);
  if (!row) return undefined;
  const task = activityTask.parse(row);
  const policy = activity.practice.policy.student;
  const pending = policy.ownSubmission.onFinal.includes("passageGradingStatus") ? { status: "pending" as const } : undefined;
  if (task.status !== "done") return pending;
  const result = counts.parse(database.prepare(`
    SELECT COALESCE(SUM(correct), 0) AS correctCount, COUNT(*) AS questionCount
    FROM automatic_verdicts WHERE submission_id = ? AND target_id = ?
  `).get(task.submission_id, task.target_id));
  if (result.questionCount !== activity.practice.questions.length) return pending;
  const fields = Object.fromEntries(policy.passageScore.fields.map(field => [field, result[field]]));
  return { status: "complete" as const, ...fields };
}
