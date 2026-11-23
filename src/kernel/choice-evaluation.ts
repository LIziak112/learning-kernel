import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChoiceConfirmation } from "../contracts/choice-confirmation.ts";
import type { SubmissionReceipt } from "../contracts/reading.ts";
import type { ReadingActivity } from "./activity.ts";
import { assessmentTarget, readAutomaticVerdicts } from "./verdict-state.ts";

const verdict = z.boolean();

export function readChoiceEvaluation(database: DatabaseSync, activity: ReadingActivity, receipt: SubmissionReceipt, confirmation: ChoiceConfirmation) {
  const assessment = activity.practice.grading.assessment;
  if (!assessment) return undefined;
  const target = assessmentTarget(database, activity.activityId);
  if (target?.submissionId !== receipt.id) throw new Error("已确认的评分任务不存在");
  const evaluator = assessment.evaluator;
  if (target.status !== "done") return { status: target.status, evaluator };
  const automatic = new Map(readAutomaticVerdicts(database, target).map(({ questionId, correct }) => [questionId, correct]));
  const questions = confirmation.questions.map(({ questionId, questionVersion }) => ({
    questionId, questionVersion, correct: verdict.parse(automatic.get(questionId)),
  }));
  return {
    status: "evaluated" as const, evaluator, questionCount: questions.length,
    correctCount: questions.filter(question => question.correct).length, questions,
  };
}
