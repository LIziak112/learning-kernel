import type { DatabaseSync } from "node:sqlite";
import type { ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";
import type { ReadingAnswer } from "../contracts/reading-runtime.ts";
import type { ReadingActivity } from "./activity.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { activitySubmissions } from "./submission-store.ts";
import type { Observation, StoredSubmission } from "./submission-store.ts";

export function findSource(
  submissions: readonly StoredSubmission[],
  input: { stepId: string; slotId: string },
) {
  return submissions.find(item => item.stepId === input.stepId && item.receipt.slotId === input.slotId);
}

export function verifyAnswerReferences(database: DatabaseSync, activityId: string, step: ReadingStep, answer: ReadingAnswer) {
  const stored = activitySubmissions(database, activityId);
  const references = Object.entries(step.submit.slots).filter(([, slot]) => slot.type === "reuse");
  if (references.length !== Object.keys(answer.references).length) throw new LearningError(403, "FORBIDDEN");
  for (const [name, slot] of references) {
    const input = step.inputs[slot.source];
    if (input?.from !== "submission") throw new LearningError(403, "FORBIDDEN");
    const submitted = findSource(stored, input);
    if (!submitted || submitted.receipt.id !== answer.references[name]) throw new LearningError(403, "FORBIDDEN");
  }
}

export function answerObservations(
  activity: ReadingActivity,
  slot: Extract<ReadingSlot, { type: "oneChoicePerQuestion" }>,
  answer: ReadingAnswer,
): Observation[] {
  const questions = activity.practice.questions;
  if (Object.keys(answer.choices).length !== questions.length || questions.some(question => !validChoice(question, answer))) {
    throw new LearningError(422, "INVALID_CHOICES");
  }
  const observations = questions.map(question => ({ targetId: slot.targetId, unitId: `question:${question.id}` }));
  if (slot.reasonTargetId && answer.reason?.independent) {
    observations.push({ targetId: slot.reasonTargetId, unitId: "reason" });
  }
  return observations;
}

function validChoice(question: ReadingActivity["practice"]["questions"][number], answer: ReadingAnswer) {
  const choice = answer.choices[question.id];
  return choice !== undefined && Object.hasOwn(question.options, choice);
}
