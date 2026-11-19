import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ReadingActivity } from "./activity.ts";
import { activeTeacherVerdict, verdictHistory } from "./verdict-history.ts";

const assessment = z.strictObject({ submissionId: z.uuid(), targetId: z.string(), status: z.enum(["pending", "done"]) });
const storedAutomatic = z.strictObject({
  questionId: z.string(), correct: z.literal([0, 1]).transform(Boolean), valid: z.literal([0, 1]).transform(Boolean),
});

export function assessmentTarget(database: DatabaseSync, activityId: string) {
  const target = database.prepare(`
    SELECT t.submission_id AS submissionId, t.target_id AS targetId, t.status
    FROM evaluation_tasks t JOIN completions c ON c.submission_id = t.submission_id
    WHERE c.activity_id = ?
  `).get(activityId);
  return target ? assessment.parse(target) : undefined;
}

export function readAutomaticVerdicts(database: DatabaseSync, { submissionId, targetId }: { submissionId: string; targetId: string }) {
  return database.prepare(`
    SELECT question_id AS questionId, correct, valid FROM automatic_verdicts WHERE submission_id = ? AND target_id = ?
  `).all(submissionId, targetId).map(row => storedAutomatic.parse(row));
}

export function questionVerdicts(database: DatabaseSync, activity: ReadingActivity, target: z.infer<typeof assessment>) {
  const automatic = readAutomaticVerdicts(database, target);
  const history = verdictHistory(database, target);
  return activity.practice.questions.map(question => {
    const questionHistory = history.filter(event => event.questionId === question.id);
    const original = automatic.find(item => item.questionId === question.id);
    const automaticBasis = original && { correct: original.correct, valid: original.valid };
    const effective = activeTeacherVerdict(questionHistory) ?? effectiveAutomatic(automaticBasis);
    return {
      submissionId: target.submissionId, targetId: target.targetId, questionId: question.id,
      prompt: question.prompt,
      revision: questionHistory.at(-1)?.revision ?? 0, effective, automatic: automaticBasis, history: questionHistory,
    };
  });
}

function effectiveAutomatic(verdict: { correct: boolean; valid: boolean } | undefined) {
  return verdict?.valid ? { source: "automatic" as const, correct: verdict.correct } : undefined;
}
