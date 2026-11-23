import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput, QuestionDeliveryInput } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "grading-status-student" } as const;
const reviewer = { role: "reviewer", id: "grading-status-reviewer" } as const;
const essay = { id: "essay", version: 2, prompt: "说明实验结论。", response: "textWithOptionalTitle" } as const;
const reflection = { id: "reflection", version: 3, prompt: "写一处可改进的地方。", response: "textWithOptionalTitle" } as const;
const slotId = "paper";
const original = { state: "frozen", documentId: "paper-document", versionId: "paper-frozen-1", sha256: "b".repeat(64) } as const;
const passageScore = {
  whenAll: ["finalConfirmed", "allQuestionsJudged"], group: "wholePassage", fields: ["correctCount", "questionCount"],
  allowSubsets: false, drilldown: false,
} satisfies NonNullable<StudentPolicy["passageScore"]>;

type Runtime = ReturnType<typeof openLearningRuntime>;
type StudentPolicy = Extract<PublicationInput["practice"], { policy: unknown }>["policy"]["student"];

function subjectivePaper(id: string, student: StudentPolicy = {
  ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] },
}) {
  return {
    practice: {
      id, version: 1, formatVersion: 1, title: "主观题整卷", goals: { judged: "教师评阅" }, questions: [essay, reflection],
      steps: [{
        id: "answer", instructions: "作答全部主观题。", tool: { id: "question-delivery", version: 1 },
        inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { [slotId]: {
          type: "questionDelivery", source: "questions", targetId: "judged", delivery: { mode: "whole" },
          confirmFromDrafts: { allowUnanswered: true },
        } } },
        afterConfirmation: "finish",
      }],
      grading: { teacherReview: { questionIds: [essay.id, reflection.id] } },
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled", student,
        reviewer: { scope: "assignedReviewer", fields: ["studentChoices"], actions: ["reviseQuestionVerdict"] },
        manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  } satisfies PublicationInput;
}

const scoredStudent: StudentPolicy = {
  ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: ["passageGradingStatus"] },
  passageScore,
};

function handIn(runtime: Runtime, practiceId: string) {
  const activity = runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: "start-" + practiceId });
  const revisions = [essay, reflection].map(question => {
    const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
      slotId, questionId: question.id, questionVersion: question.version, operationId: "save-" + question.id, baseRevision: 0,
      value: { body: "学生作答 " + question.id, title: "" } });
    return { questionId: question.id, questionVersion: question.version, revision: saved.revision, original };
  });
  const input: QuestionDeliveryInput = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, source: "whole",
    operationId: "hand-in", questions: revisions };
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  runtime.evaluatePending();
  const key = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, operationId: input.operationId } as const;
  const judge = (questionId: string, correct: boolean) => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, {
    protocolVersion: 1, submissionId: receipt.id, targetId: "judged", questionId, operationId: "judge-" + questionId,
    action: "override", correct, reason: "教师评阅", expectedRevision: 0,
  });
  return { activity, key, judge };
}

function open(t: Parameters<typeof scenarioDatabase>[0]) {
  const runtime = openLearningRuntime({ databasePath: scenarioDatabase(t), verifyOriginal: () => true,
    authorizeConfirmationRecovery: () => true, authorizeReview: access => access.reviewerId === reviewer.id });
  t.after(() => runtime.close());
  return runtime;
}

test("整卷主观题｜交卷后学生读面为已完成且没有任何成绩字段，教师判完后仍不公布", t => {
  const runtime = open(t);
  runtime.publish(subjectivePaper("subjective-current"));
  const { activity, key, judge } = handIn(runtime, "subjective-current");
  const handedIn = runtime.read(student, activity.activityId);
  assert.equal(handedIn.status, "completed");
  assert.equal(Object.hasOwn(handedIn, "assessment"), false);
  const pending = [essay, reflection].map(({ id: questionId, version: questionVersion }) => ({ questionId, questionVersion, status: "needsReview" }));
  const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
  assert.equal(recovered.assessment, "teacherReview");
  assert.deepEqual(recovered.review, { questions: pending });
  judge(essay.id, true);
  judge(reflection.id, false);
  const judged = runtime.read(student, activity.activityId);
  assert.equal(judged.status, "completed");
  assert.equal(Object.hasOwn(judged, "assessment"), false);
  assert.doesNotMatch(JSON.stringify(judged), /correctCount|questionCount|teacherReview|教师评阅/);
  assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared").review, { questions: pending });
});

test("整卷主观题｜题组交付拒绝声明整篇待批状态与成绩公布", t => {
  const runtime = open(t);
  assert.throws(() => runtime.publish(subjectivePaper("subjective-scored", scoredStudent)), (error: unknown) => {
    assert.ok(error instanceof ZodError);
    assert.ok(error.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(["practice", "policy"])
      && issue.message === "原值确认只支持回执与本人获准作答"), JSON.stringify(error.issues));
    return true;
  });
});
