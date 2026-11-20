import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { choiceKeyCapability, readingCapability } from "../builtins/reading-capabilities.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import { readingPracticeSchema, scoringKeySchema } from "../contracts/reading-publication.ts";
import { readingAnswer } from "../contracts/reading-runtime.ts";
import type { ReadingActivity } from "./activity.ts";
import { questionDeliverySlot } from "./question-delivery-publication.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";

const storedKey = z.object({ definition: z.string() });
const task = z.strictObject({
  submissionId: z.uuid(),
  targetId: z.string(),
  stepId: z.string(),
  slotId: z.string(),
  keyJSON: z.string(),
  practiceJSON: z.string(),
  answerJSON: z.string(),
});

export function queueEvaluation(
  database: DatabaseSync,
  activity: ReadingActivity,
  receipt: SubmissionReceipt,
  targetId: string, assessmentSlotId = receipt.slotId,
) {
  const { assessment } = activity.practice.grading;
  if (!assessment || assessment.from.stepId !== activity.step.id || assessment.from.slotId !== assessmentSlotId) return;
  database.prepare(`
    INSERT INTO evaluation_tasks (submission_id, key_id, key_version, target_id, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(receipt.id, assessment.keyRef.id, assessment.keyRef.version, targetId);
}

export function evaluatePending(database: DatabaseSync, checkpoint?: RuntimeCheckpoint) {
  const pending = database.prepare(`
    SELECT t.submission_id AS submissionId, t.target_id AS targetId, a.step_id AS stepId, s.slot_id AS slotId, k.definition AS keyJSON,
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
  const practice = readingPracticeSchema.parse(JSON.parse(input.practiceJSON));
  if (usesHostEvaluation(practice, input)) return;
  checkpoint?.({ point: "beforeEvaluation", submissionId: input.submissionId });
  const assessment = practice.grading.assessment;
  if (!assessment || readingCapability(assessment.evaluator) !== choiceKeyCapability) throw new Error("已发布评估器不可用");
  const key = scoringKeySchema.parse(JSON.parse(input.keyJSON));
  const answer = readingAnswer.parse(JSON.parse(input.answerJSON));
  const verdicts = practice.questions.map(({ id: questionId }) => ({
    questionId, correct: key.acceptedChoices[questionId] === answer.choices[questionId],
  }));
  recordEvaluation(database, input, verdicts, checkpoint);
}

function usesHostEvaluation(practice: z.infer<typeof readingPracticeSchema>, { stepId, slotId }: z.infer<typeof task>) {
  const step = practice.steps.find(step => step.id === stepId);
  const slot = step?.submit.slots[slotId];
  switch (slot?.type) {
    case "oneResponsePerQuestion": return true;
    case "oneChoicePerQuestion": return slot.confirmFromDrafts !== undefined;
    default: return Boolean(step && questionDeliverySlot(step));
  }
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
