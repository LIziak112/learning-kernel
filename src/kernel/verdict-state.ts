import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ReadingActivity } from "./activity.ts";
import { activeTeacherVerdict, verdictHistory } from "./verdict-history.ts";

const assessment = z.strictObject({ submissionId: z.uuid(), targetId: z.string(), status: z.enum(["pending", "done"]) });
const storedAutomatic = z.strictObject({
  questionId: z.string(), correct: z.literal([0, 1]).transform(Boolean), valid: z.literal([0, 1]).transform(Boolean),
});

export function assessmentTarget(database: DatabaseSync, activityId: string) {
  return findAssessmentTarget(database, "submission_id = (SELECT submission_id FROM completions WHERE activity_id = ?)", activityId);
}

export function submissionAssessmentTarget(database: DatabaseSync, submissionId: string) {
  return findAssessmentTarget(database, "submission_id = ?", submissionId);
}

function findAssessmentTarget(database: DatabaseSync, condition: string, id: string) {
  const target = database.prepare(`
    SELECT submission_id AS submissionId, target_id AS targetId, status
    FROM evaluation_tasks WHERE ${condition}
  `).get(id);
  return target ? assessment.parse(target) : undefined;
}

export function readAutomaticVerdicts(database: DatabaseSync, { submissionId, targetId }: { submissionId: string; targetId: string }) {
  return database.prepare(`
    SELECT question_id AS questionId, correct, valid FROM automatic_verdicts WHERE submission_id = ? AND target_id = ?
  `).all(submissionId, targetId).map(row => storedAutomatic.parse(row));
}

export function questionVerdicts(database: DatabaseSync, activity: ReadingActivity, target: z.infer<typeof assessment>) {
  const questions = activity.practice.questions.map(({ id: questionId, prompt }) => ({ questionId, prompt }));
  return questionVerdictStates(database, target, questions);
}

export function questionVerdictStates<Question extends { questionId: string }>(
  database: DatabaseSync, target: z.infer<typeof assessment>, questions: readonly Question[],
) {
  const automatic = readAutomaticVerdicts(database, target);
  const history = verdictHistory(database, target);
  return questions.map(question => {
    const { questionId } = question;
    const questionHistory = history.filter(event => event.questionId === questionId);
    const original = automatic.find(item => item.questionId === questionId);
    const automaticBasis = original && { correct: original.correct, valid: original.valid };
    const effective = activeTeacherVerdict(questionHistory) ?? effectiveAutomatic(automaticBasis);
    return {
      ...question, submissionId: target.submissionId, targetId: target.targetId,
      revision: questionHistory.at(-1)?.revision ?? 0, effective, automatic: automaticBasis, history: questionHistory,
    };
  });
}

function effectiveAutomatic(verdict: { correct: boolean; valid: boolean } | undefined) {
  return verdict?.valid ? { source: "automatic" as const, correct: verdict.correct } : undefined;
}
