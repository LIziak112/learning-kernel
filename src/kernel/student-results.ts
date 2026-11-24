import type { DatabaseSync } from "node:sqlite";
import { readQuestionDelivery } from "../contracts/question-delivery.ts";
import type { ReadingActivity } from "./activity.ts";
import { confirmedDeliveryAssessment } from "./question-delivery-evaluation.ts";
import { questionDeliverySlot } from "./question-delivery-publication.ts";
import { reviewDisclosure } from "./review-access.ts";
import type { SelfAssessmentScoring } from "../contracts/self-assessment.ts";
import { currentSelfAssessments, selfAssessmentCounts, selfAssessmentScoring, selfReviewQuestionIds } from "./self-assessment.ts";
import { activitySubmissions } from "./submission-store.ts";
import { assessmentTarget, questionVerdicts, questionVerdictStates, submissionReviewTarget } from "./verdict-state.ts";

type StudentPolicy = ReadingActivity["practice"]["policy"]["student"];
type Graded = { questionId: string; correct: boolean };

export function studentResults(database: DatabaseSync, activity: ReadingActivity) {
  const policy = activity.practice.policy.student;
  const delivery = questionDeliverySlot(activity.step);
  if (delivery) return deliveryResults(database, activity, policy, delivery[1].targetId);
  const target = assessmentTarget(database, activity.activityId);
  if (!target || !policy.passageScore) return {};
  const pending = policy.ownSubmission.onFinal.includes("passageGradingStatus") ? { status: "pending" as const } : undefined;
  if (target.status !== "done") return { assessment: pending };
  const graded = questionVerdicts(database, activity, target).flatMap(({ questionId, effective }) =>
    effective ? [{ questionId, correct: effective.correct }] : []);
  if (graded.length !== activity.practice.questions.length) return { assessment: pending };
  return {
    assessment: passageAssessment(policy.passageScore, graded),
    review: policy.review && studentReview(database, activity.activityId, policy.review, graded),
  };
}

function passageAssessment(score: NonNullable<StudentPolicy["passageScore"]>, graded: readonly Graded[]) {
  return scoreFields(score, { questionCount: graded.length, correctCount: graded.filter(item => item.correct).length });
}

function scoreFields(score: NonNullable<StudentPolicy["passageScore"]>, result: { questionCount: number; correctCount: number }) {
  return { status: "complete" as const, ...Object.fromEntries(score.fields.map(field => [field, result[field]])) };
}

type SelfSummary = { scoring: SelfAssessmentScoring; judgedCorrect: number; selfAssessedCorrect: number; selfAssessedWrong: number };
type DeliveryResults = {
  assessment?: (ReturnType<typeof scoreFields> & { selfAssessment?: SelfSummary }) | { status: "pending" };
  review?: undefined;
};

function deliveryResults(database: DatabaseSync, activity: ReadingActivity, policy: StudentPolicy, targetId: string): DeliveryResults {
  if (!activity.completed || !policy.passageScore) return {};
  const routed = selfReviewQuestionIds(activity);
  const entries = activitySubmissions(database, activity.activityId).flatMap(({ receipt, content }) => {
    const delivered = readQuestionDelivery(content);
    const target = delivered && submissionReviewTarget(database, receipt.id, targetId);
    if (!delivered || !target) return [];
    const { automatic, review } = confirmedDeliveryAssessment(activity, delivered);
    const current = currentSelfAssessments(database, receipt.id);
    return questionVerdictStates(database, target, [...automatic, ...review]).map(({ questionId, effective }) => ({
      ...effective && { effective }, self: routed.has(questionId) ? current.get(questionId)?.verdict ?? null : null,
    }));
  });
  if (entries.filter(({ effective, self }) => effective || self).length !== activity.practice.questions.length) {
    return policy.ownSubmission.onFinal.includes("passageGradingStatus") ? { assessment: { status: "pending" } } : {};
  }
  const scoring = selfAssessmentScoring(activity);
  if (!scoring) {
    const correctCount = entries.filter(({ effective }) => effective?.correct).length;
    return { assessment: scoreFields(policy.passageScore, { questionCount: entries.length, correctCount }) };
  }
  const { questionCount, correctCount, judgedCorrect, selfAssessedCorrect, selfAssessedWrong } = selfAssessmentCounts(scoring, entries);
  return {
    assessment: {
      ...scoreFields(policy.passageScore, { questionCount, correctCount }),
      selfAssessment: { scoring, judgedCorrect, selfAssessedCorrect, selfAssessedWrong },
    },
  };
}

type PublishedReview = NonNullable<ReadingActivity["practice"]["policy"]["student"]["review"]>;

function studentReview(database: DatabaseSync, activityId: string, policy: PublishedReview, graded: Graded[]) {
  const disclosure = reviewDisclosure(database, activityId);
  if (!disclosure?.reviewOpen) return undefined;
  const byQuestion = policy.byQuestion.includes("effectiveVerdict") ? graded : undefined;
  const selectionFeedback = policy.byQuoteSet.includes("learnerFeedback") ? disclosure.feedback ?? undefined : undefined;
  if (!byQuestion && !selectionFeedback) return undefined;
  return { byQuestion, selectionFeedback };
}
