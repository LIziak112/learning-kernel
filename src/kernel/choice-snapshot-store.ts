import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChoiceDraftScope } from "../contracts/choice-draft.ts";
import { choiceSnapshotContent, choiceSnapshotRevision } from "../contracts/choice-snapshot.ts";
import { readingQuestion } from "../contracts/reading-publication.ts";
import type { ReadingPublication } from "../contracts/reading-publication.ts";

const storedSnapshot = choiceSnapshotRevision.extend({ content: z.string() });
const draftRevision = z.strictObject({ revision: z.int().positive() });
const editedQuestion = readingQuestion.pick({ prompt: true, options: true });

export const choiceSnapshotOffsetForWork = `COALESCE((SELECT MAX(s.revision) FROM choice_snapshot_revisions s
  WHERE s.step_attempt_id = w.step_attempt_id AND s.slot_id = w.slot_id AND s.question_id = w.question_id), 0)`;

type FrozenQuestion = ReadingPublication["practice"]["questions"][number];
type SnapshotScope = Pick<ChoiceDraftScope, "stepAttemptId" | "slotId" | "questionId">;

export function effectiveChoiceQuestions(database: DatabaseSync, stepAttemptId: string, published: readonly FrozenQuestion[]) {
  const snapshots = database.prepare(`
    SELECT r.slot_id AS slotId, r.question_id AS questionId, r.question_version AS questionVersion, r.revision, r.content
    FROM choice_snapshot_revisions r WHERE r.step_attempt_id = ?
      AND r.revision = (SELECT MAX(p.revision) FROM choice_snapshot_revisions p
        WHERE p.step_attempt_id = r.step_attempt_id AND p.slot_id = r.slot_id AND p.question_id = r.question_id)
    ORDER BY r.question_id
  `).all(stepAttemptId).map(row => storedSnapshot.parse(row));
  const byQuestion = new Map(snapshots.map(row => [row.questionId, row]));
  const questions = published.map<FrozenQuestion>(question => {
    const latest = byQuestion.get(question.id);
    if (!latest) return question;
    const patch = editedQuestion.strip().parse(JSON.parse(latest.content));
    return { ...question, version: latest.questionVersion, ...patch };
  });
  return { questions, choiceSnapshotRevisions: snapshots.map(row => {
    const { content, ...revision } = row;
    return revision;
  }) };
}

export function choiceRevisionBeforeAnswers(database: DatabaseSync, { stepAttemptId, slotId, questionId }: SnapshotScope) {
  const row = database.prepare(`
    SELECT revision FROM choice_snapshot_revisions WHERE step_attempt_id = ? AND slot_id = ? AND question_id = ?
    ORDER BY revision DESC LIMIT 1
  `).get(stepAttemptId, slotId, questionId);
  return row ? draftRevision.parse(row).revision : 0;
}

export function revisedChoiceKey(
  database: DatabaseSync, { stepAttemptId, slotId, questionId }: SnapshotScope, questionVersion: number,
) {
  const row = database.prepare(`
    SELECT content FROM choice_snapshot_revisions
    WHERE step_attempt_id = ? AND slot_id = ? AND question_id = ? AND question_version = ?
  `).get(stepAttemptId, slotId, questionId, questionVersion);
  return row ? choiceSnapshotContent.parse(JSON.parse(String(row.content))).acceptedChoice : undefined;
}
