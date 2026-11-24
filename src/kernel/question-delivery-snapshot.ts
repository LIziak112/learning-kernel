import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { choiceSnapshotRevision } from "../contracts/choice-snapshot.ts";
import type { AuthorizeChoiceSnapshotRevision, HasChoiceSnapshotEvidence } from "../contracts/choice-snapshot.ts";
import { LearningError } from "../contracts/learning-error.ts";
import type { ParsedQuestionDeliverySnapshotRevision } from "../contracts/question-delivery-amendment.ts";
import type { ReadingActivity } from "./activity.ts";
import { ChoiceSnapshotRevisionConflict } from "./choice-snapshot.ts";
import { requireChoiceReviewerActivity } from "./choice-reviewer.ts";
import { revisedQuestion } from "./choice-snapshot-store.ts";
import { writeTransaction } from "./database.ts";
import { validateQuestionShape } from "./publication-bindings.ts";
import { deliveryPosition, openDraftState } from "./question-delivery-amendment.ts";
import { requireFrozenQuestion } from "./question-delivery-drafts.ts";
import { frozenResponseType } from "./question-types.ts";
import type { Registry } from "./registry.ts";

type SnapshotPolicy = { authorize: AuthorizeChoiceSnapshotRevision | undefined; hasEvidence: HasChoiceSnapshotEvidence | undefined };
type Question = ReadingActivity["practice"]["questions"][number];

const storedRevision = choiceSnapshotRevision.extend({
  previousQuestionVersion: z.int().positive(), content: z.string(), reason: z.string(),
});

export function reviseQuestionDeliverySnapshot(
  database: DatabaseSync, registry: Registry, reviewer: string, activityId: string, input: ParsedQuestionDeliverySnapshotRevision,
  clock: () => Date, policy: SnapshotPolicy,
) {
  return writeTransaction(database, () => {
    const { baseRevision, operationId, reason } = input;
    const { activity, scope } = requireChoiceReviewerActivity(database, reviewer, activityId, input,
      reviewerScope => policy.authorize?.({ ...reviewerScope, baseRevision, operationId }));
    const position = deliveryPosition(registry, activity, input);
    const content = JSON.stringify({ question: input.question, ...input.key === undefined ? {} : { key: input.key } });
    const previous = recoverRevision(database, reviewer, position, input, content);
    if (previous) return { ...previous, slotId: input.slotId };
    const question = requireFrozenQuestion(activity, input);
    const { head, revision } = openDraftState(database, activity, position);
    if (revision !== baseRevision) throw new ChoiceSnapshotRevisionConflict(revision);
    if (head || (policy.hasEvidence && policy.hasEvidence({ ...scope, baseRevision, operationId }) !== false)) {
      throw new LearningError(409, "RESPONSE_EVIDENCE_EXISTS");
    }
    const questionVersion = input.questionVersion + 1;
    requireSameGrading(registry, activity, revisedQuestion(question, questionVersion, content), input.key);
    database.prepare(`
      INSERT INTO choice_snapshot_revisions
        (step_attempt_id, slot_id, question_id, revision, previous_question_version, question_version,
         content, reviewer_id, operation_id, reason, revised_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(position.stepAttemptId, position.slotId, position.questionId, revision + 1, input.questionVersion, questionVersion,
      content, reviewer, operationId, reason, clock().toISOString());
    return { slotId: input.slotId, questionId: input.questionId, questionVersion, revision: revision + 1,
      previousQuestionVersion: input.questionVersion };
  });
}

function requireSameGrading(registry: Registry, activity: ReadingActivity, next: Question, key: ParsedQuestionDeliverySnapshotRevision["key"]) {
  const type = frozenResponseType(registry, activity.practice, next);
  let valid = true;
  validateQuestionShape(next, type.id, registry, () => { valid = false; });
  if (!valid) throw new LearningError(422, "INVALID_QUESTION");
  const { assessment, teacherReview } = activity.practice.grading;
  const automatic = assessment !== undefined && !teacherReview?.questionIds.includes(next.id);
  if (automatic ? key === undefined || type.parseKey?.(key, next) === undefined : key !== undefined) {
    throw new LearningError(422, "INVALID_KEY");
  }
}

function recoverRevision(
  database: DatabaseSync, reviewer: string, position: { stepAttemptId: string; slotId: string; questionId: string },
  input: ParsedQuestionDeliverySnapshotRevision, expectedContent: string,
) {
  const found = database.prepare(`
    SELECT slot_id AS slotId, question_id AS questionId, question_version AS questionVersion, revision,
      previous_question_version AS previousQuestionVersion, content, reason
    FROM choice_snapshot_revisions WHERE step_attempt_id = ? AND slot_id = ? AND question_id = ? AND reviewer_id = ? AND operation_id = ?
  `).get(position.stepAttemptId, position.slotId, position.questionId, reviewer, input.operationId);
  if (!found) return undefined;
  const { content, reason, ...receipt } = storedRevision.parse(found);
  if (receipt.previousQuestionVersion !== input.questionVersion || receipt.revision - 1 !== input.baseRevision
    || content !== expectedContent || reason !== input.reason) throw new LearningError(409, "OPERATION_CONFLICT");
  return receipt;
}
