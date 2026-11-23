import type { DatabaseSync } from "node:sqlite";
import type { ReadingActivity } from "./activity.ts";
import { reviewDisclosure } from "./review-access.ts";
import { assessmentTarget, questionVerdicts } from "./verdict-state.ts";

export function studentResults(database: DatabaseSync, activity: ReadingActivity) {
  const policy = activity.practice.policy.student;
  const target = assessmentTarget(database, activity.activityId);
  if (!target || !policy.passageScore) return {};
  const pending = policy.ownSubmission.onFinal.includes("passageGradingStatus") ? { status: "pending" as const } : undefined;
  if (target.status !== "done") return { assessment: pending };
  const graded = questionVerdicts(database, activity, target).flatMap(({ questionId, effective }) =>
    effective ? [{ questionId, correct: effective.correct }] : []);
  if (graded.length !== activity.practice.questions.length) return { assessment: pending };
  const result = { questionCount: graded.length, correctCount: graded.filter(item => item.correct).length };
  const fields = Object.fromEntries(policy.passageScore.fields.map(field => [field, result[field]]));
  return {
    assessment: { status: "complete" as const, ...fields },
    review: policy.review && studentReview(database, activity.activityId, policy.review, graded),
  };
}

type PublishedReview = NonNullable<ReadingActivity["practice"]["policy"]["student"]["review"]>;

function studentReview(database: DatabaseSync, activityId: string, policy: PublishedReview, graded: { questionId: string; correct: boolean }[]) {
  const disclosure = reviewDisclosure(database, activityId);
  if (!disclosure?.reviewOpen) return undefined;
  const byQuestion = policy.byQuestion.includes("effectiveVerdict") ? graded : undefined;
  const selectionFeedback = policy.byQuoteSet.includes("learnerFeedback") ? disclosure.feedback ?? undefined : undefined;
  if (!byQuestion && !selectionFeedback) return undefined;
  return { byQuestion, selectionFeedback };
}
