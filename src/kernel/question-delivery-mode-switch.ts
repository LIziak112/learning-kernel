import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { questionDeliveryReviewBasis, questionDeliveryScoringKey } from "../contracts/question-delivery.ts";
import type { VersionRef } from "../contracts/reading.ts";
import type { ReadingPublication } from "../contracts/reading-publication.ts";
import type { ReadingActivity } from "./activity.ts";
import { LearningError } from "../contracts/learning-error.ts";
import { questionDeliveryPosition } from "./question-delivery-drafts.ts";
import { questionDeliverySlot } from "./question-delivery-publication.ts";
import type { DeliverySlot } from "./question-delivery-publication.ts";

type Practice = ReadingPublication["practice"];
const draftPlacement = z.strictObject({ id: z.uuid(), stepAttemptId: z.uuid().nullable(),
  slotId: z.string().nullable(), questionId: z.string().nullable() });
const storedKey = z.strictObject({ definition: z.string() });
const keySchema = z.union([questionDeliveryScoringKey, questionDeliveryReviewBasis]);

export function rebindQuestionDeliveryDrafts(database: DatabaseSync, activity: ReadingActivity, practice: Practice, stepAttemptId: string) {
  const { activityId, practice: currentPractice } = activity;
  const [current, next] = switchableSlots(database, currentPractice, practice);
  const drafts = database.prepare(`
    SELECT id, step_attempt_id AS stepAttemptId, slot_id AS slotId, question_id AS questionId
    FROM works WHERE activity_id = ?
  `).all(activityId).map(row => draftPlacement.parse(row));
  if (!drafts.length) throw new LearningError(409, "QUESTION_DELIVERY_MODE_CONFLICT");
  const questionIds = new Set(currentPractice.questions.map(question => question.id));
  database.exec("PRAGMA defer_foreign_keys = ON");
  const move = database.prepare("UPDATE works SET step_attempt_id = ?, slot_id = ? WHERE id = ?");
  for (const draft of drafts) {
    if (draft.stepAttemptId !== activity.stepAttemptId || draft.questionId === null || !questionIds.has(draft.questionId)
      || draft.slotId !== questionDeliveryPosition(current[1], current[0], draft.questionId)) {
      throw new LearningError(409, "QUESTION_DELIVERY_MODE_CONFLICT");
    }
    move.run(stepAttemptId, questionDeliveryPosition(next[1], next[0], draft.questionId), draft.id);
  }
}

function switchableSlots(database: DatabaseSync, current: Practice, next: Practice) {
  const currentSlot = questionDeliverySlot(current.steps[0]);
  const nextSlot = questionDeliverySlot(next.steps[0]);
  if (!currentSlot || !nextSlot || currentSlot[1].delivery.mode === nextSlot[1].delivery.mode
    || !isDeepStrictEqual(frozenDefinition(current, currentSlot), frozenDefinition(next, nextSlot))
    || !isDeepStrictEqual(gradingBasis(database, current), gradingBasis(database, next))) {
    throw new LearningError(409, "QUESTION_DELIVERY_MODE_CONFLICT");
  }
  return [currentSlot, nextSlot] as const;
}

function frozenDefinition(
  { version, questions, steps: [step, ...remaining], grading: { assessment, manualReview, ...grading }, ...practice }: Practice,
  [slotId, { delivery, ...slot }]: [string, DeliverySlot],
) {
  const { keyRef, ...automatic } = assessment ?? {};
  return {
    ...practice,
    questions: questions.map(({ options, ...question }) => ({ ...question, options: Object.entries(options) })),
    steps: [{ ...step, submit: { ...step.submit, slots: { ...step.submit.slots, [slotId]: slot } } }, ...remaining],
    grading: { ...grading, assessment: assessment ? automatic : undefined, manualReview: manualReview !== undefined },
  };
}

function gradingBasis(database: DatabaseSync, { grading: { assessment, manualReview } }: Practice) {
  const reference: VersionRef | undefined = assessment?.keyRef ?? manualReview?.keyRef;
  if (!reference) return undefined;
  const { definition } = storedKey.parse(database.prepare("SELECT definition FROM scoring_keys WHERE id = ? AND version = ?")
    .get(reference.id, reference.version));
  const { id, version, ...basis } = keySchema.parse(JSON.parse(definition));
  return basis;
}
