import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { choiceSnapshotRevision } from "../contracts/choice-snapshot.ts";
import type { AuthorizeChoiceSnapshotRevision, ChoiceSnapshotRevisionInput, HasChoiceSnapshotEvidence } from "../contracts/choice-snapshot.ts";
import type { ReadingActivity } from "./activity.ts";
import { choiceState, readChoiceHead, requireDraftQuestion } from "./choice-drafts.ts";
import { requireChoiceReviewerActivity } from "./choice-reviewer.ts";
import { writeTransaction } from "./database.ts";
import { LearningError } from "./learning-error.ts";
import { boundOutput } from "./reading-progress.ts";

export class ChoiceSnapshotRevisionConflict extends LearningError {
  readonly current: Readonly<{ revision: number }>;

  constructor(revision: number) {
    super(409, "ANSWER_REVISION_CONFLICT");
    this.current = { revision };
  }
}

const storedRevision = choiceSnapshotRevision.extend({
  previousQuestionVersion: z.int().positive(), content: z.string(), reason: z.string(),
});

type SnapshotPolicy = { authorize: AuthorizeChoiceSnapshotRevision | undefined; hasEvidence: HasChoiceSnapshotEvidence | undefined };

export function reviseChoiceSnapshot(
  database: DatabaseSync, reviewer: string, activityId: string, input: ChoiceSnapshotRevisionInput,
  clock: () => Date, policy: SnapshotPolicy,
) {
  return writeTransaction(database, () => {
    const { baseRevision, operationId, prompt, options, acceptedChoice, reason } = input;
    const { activity, scope } = requireChoiceReviewerActivity(database, reviewer, activityId, input,
      reviewerScope => policy.authorize?.({ ...reviewerScope, baseRevision, operationId }));
    const content = JSON.stringify({ prompt, options, acceptedChoice });
    const previous = recoverSnapshotRevision(database, reviewer, input, content);
    if (previous) return previous;
    const question = requireDraftQuestion(activity, input);
    requireScoredConfirmationSlot(activity, input.slotId);
    const current = readChoiceHead(database, activityId, input);
    const { revision } = choiceState(database, input, current);
    if (revision !== baseRevision) throw new ChoiceSnapshotRevisionConflict(revision);
    if (current || hasWholeDraftAnswer(database, activityId, input)) throw new LearningError(409, "RESPONSE_EVIDENCE_EXISTS");
    if (policy.hasEvidence && policy.hasEvidence({ ...scope, baseRevision, operationId }) !== false) {
      throw new LearningError(409, "RESPONSE_EVIDENCE_EXISTS");
    }
    if (!Object.hasOwn(options, acceptedChoice)) throw new LearningError(422, "INVALID_CHOICE");
    const { stepAttemptId, slotId, questionId, questionVersion: previousQuestionVersion } = input;
    const nextVersion = previousQuestionVersion + 1;
    const nextRevision = revision + 1;
    const receipt = choiceSnapshotRevision.parse({ slotId, questionId: question.id, questionVersion: nextVersion, revision: nextRevision });
    database.prepare(`
      INSERT INTO choice_snapshot_revisions
        (step_attempt_id, slot_id, question_id, revision, previous_question_version, question_version,
         content, reviewer_id, operation_id, reason, revised_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(stepAttemptId, slotId, questionId, nextRevision, previousQuestionVersion, nextVersion, content, reviewer, operationId,
      reason, clock().toISOString());
    return { ...receipt, previousQuestionVersion };
  });
}

function requireScoredConfirmationSlot(activity: ReadingActivity, slotId: string) {
  const slot = boundOutput(activity.step, slotId);
  const scored = activity.practice.grading.assessment?.from;
  if (slot.type !== "oneChoicePerQuestion" || !slot.confirmFromDrafts || scored?.slotId !== slotId) {
    throw new LearningError(422, "INVALID_SLOT");
  }
}

function hasWholeDraftAnswer(database: DatabaseSync, activityId: string, { stepAttemptId, slotId, questionId }: ChoiceSnapshotRevisionInput) {
  return Boolean(database.prepare(`
    SELECT 1 FROM works w JOIN work_versions v ON v.work_id = w.id JOIN json_each(v.selection, '$.choices') answer
    WHERE w.activity_id = ? AND w.step_attempt_id = ? AND w.slot_id = ? AND w.question_id IS NULL AND answer.key = ?
    LIMIT 1
  `).get(activityId, stepAttemptId, slotId, questionId));
}

function recoverSnapshotRevision(database: DatabaseSync, reviewer: string, input: ChoiceSnapshotRevisionInput, expectedContent: string) {
  const found = database.prepare(`
    SELECT slot_id AS slotId, question_id AS questionId, question_version AS questionVersion, revision,
      previous_question_version AS previousQuestionVersion, content, reason
    FROM choice_snapshot_revisions WHERE step_attempt_id = ? AND slot_id = ? AND question_id = ? AND reviewer_id = ? AND operation_id = ?
  `).get(input.stepAttemptId, input.slotId, input.questionId, reviewer, input.operationId);
  if (!found) return undefined;
  const { content, reason, ...receipt } = storedRevision.parse(found);
  if (receipt.previousQuestionVersion !== input.questionVersion || receipt.revision - 1 !== input.baseRevision
    || content !== expectedContent || reason !== input.reason) throw new LearningError(409, "OPERATION_CONFLICT");
  return receipt;
}
