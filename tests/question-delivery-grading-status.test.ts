import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput, QuestionDeliveryInput } from "../src/server.ts";
import { booleanEvaluator } from "./fixtures/evaluators.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "grading-status-student" } as const;
const reviewer = { role: "reviewer", id: "grading-status-reviewer" } as const;
const essay = { id: "essay", version: 2, prompt: "说明实验结论。", response: "textWithOptionalTitle" } as const;
const reflection = { id: "reflection", version: 3, prompt: "写一处可改进的地方。", response: "textWithOptionalTitle" } as const;
const judge = { id: "judge", version: 4, prompt: "两次读数是否一致？", response: "booleanOrString", options: { yes: "是", no: "否" } } as const;
const slotId = "paper";
const evaluator = { id: "grading-status-evaluator", version: 1 };
const keyRef = { id: "grading-status-key", version: 1 };
const original = { state: "frozen", documentId: "paper-document", versionId: "paper-frozen-1", sha256: "b".repeat(64) } as const;
const passageScore = {
  whenAll: ["finalConfirmed", "allQuestionsJudged"], group: "wholePassage", fields: ["correctCount", "questionCount"],
  allowSubsets: false, drilldown: false,
} satisfies NonNullable<StudentPolicy["passageScore"]>;
const unscoredStudent: StudentPolicy = {
  ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] },
};
const scoredStudent: StudentPolicy = {
  ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: ["passageGradingStatus"] },
  passageScore,
};
const leak = /correctCount|questionCount|"correct"|teacherReview|教师评阅|acceptedResponse/;

type Runtime = ReturnType<typeof openLearningRuntime>;
type Practice = Extract<PublicationInput["practice"], { policy: unknown }>;
type StudentPolicy = Practice["policy"]["student"];
type Question = typeof essay | typeof reflection | typeof judge;

function paper(id: string, student: StudentPolicy, questions: readonly Question[] = [essay, reflection],
  grading: Practice["grading"] = { teacherReview: { questionIds: [essay.id, reflection.id] } }, perQuestion = false) {
  const delivery = perQuestion
    ? { mode: "perQuestion" as const, questionSlots: Object.fromEntries(questions.map(question => [question.id, "slot-" + question.id])) }
    : { mode: "whole" as const };
  return {
    practice: {
      id, version: 1, formatVersion: 1, title: "主观题整卷", goals: { judged: "教师评阅" }, questions: [...questions],
      steps: [{
        id: "answer", instructions: "作答全部题目。", tool: { id: "question-delivery", version: 1 },
        inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { [slotId]: {
          type: "questionDelivery", source: "questions", targetId: "judged", delivery, confirmFromDrafts: { allowUnanswered: true },
        } } },
        afterConfirmation: "finish",
      }],
      grading,
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled", student,
        reviewer: { scope: "assignedReviewer", fields: ["studentChoices"], actions: ["reviseQuestionVerdict"] },
        manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  } satisfies PublicationInput;
}

function mixedPaper(id: string, perQuestion = true) {
  const grading = {
    teacherReview: { questionIds: [essay.id] },
    assessment: { from: { stepId: "answer", slotId }, evaluator, keyRef, unit: "question",
      effectiveVerdictOrder: ["teacherReview", "automatic"] },
  } satisfies Practice["grading"];
  return { ...paper(id, scoredStudent, [judge, essay], grading, perQuestion),
    scoringKey: { ...keyRef, acceptedByQuestion: { [judge.id]: { response: judge.response, acceptedResponse: true } } } };
}

function startPaper(runtime: Runtime, practiceId: string) {
  return runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: "start-" + practiceId });
}

function deliver(runtime: Runtime, activity: ReturnType<typeof startPaper>, questions: readonly Question[], source: "whole" | "question") {
  const revisions = questions.map(question => {
    const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
      slotId, questionId: question.id, questionVersion: question.version, operationId: "save-" + question.id, baseRevision: 0,
      value: question.response === "booleanOrString" ? true : { body: "学生作答 " + question.id, title: "" } });
    return { questionId: question.id, questionVersion: question.version, revision: saved.revision, original };
  });
  const input: QuestionDeliveryInput = source === "whole"
    ? { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, source, operationId: "hand-in", questions: revisions }
    : { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, source, operationId: "hand-in-" + questions[0]?.id,
      questions: [revisions[0] ?? assert.fail("缺少逐题交付")] };
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  runtime.evaluatePending();
  const key = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, operationId: input.operationId } as const;
  return (questionId: string, correct: boolean) => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, {
    protocolVersion: 1, submissionId: receipt.id, targetId: "judged", questionId, operationId: "judge-" + questionId,
    action: "override", correct, reason: "教师评阅", expectedRevision: 0,
  });
}

function handIn(runtime: Runtime, practiceId: string) {
  const activity = startPaper(runtime, practiceId);
  const judgeQuestion = deliver(runtime, activity, [essay, reflection], "whole");
  const key = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, operationId: "hand-in" } as const;
  return { activity, key, judge: judgeQuestion };
}

function open(t: Parameters<typeof scenarioDatabase>[0]) {
  const runtime = openLearningRuntime({ databasePath: scenarioDatabase(t), verifyOriginal: () => true,
    authorizeConfirmationRecovery: () => true, authorizeReview: access => access.reviewerId === reviewer.id,
    evaluators: [booleanEvaluator(evaluator, ({ value, acceptedResponse }) => ({ status: "judged", correct: value === acceptedResponse }))] });
  t.after(() => runtime.close());
  return runtime;
}

function assessmentOf(view: ReturnType<Runtime["read"]>) {
  return "assessment" in view ? view.assessment : undefined;
}

function rejects(runtime: Runtime, input: PublicationInput, path: readonly (string | number)[], message: string) {
  assert.throws(() => runtime.publish(input), (error: unknown) => {
    assert.ok(error instanceof ZodError);
    assert.ok(error.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(path) && issue.message === message),
      JSON.stringify(error.issues));
    return true;
  });
}

test("整卷主观题｜未声明公布时学生读面为已完成且没有任何成绩字段，教师判完后仍不公布", t => {
  const runtime = open(t);
  runtime.publish(paper("subjective-current", unscoredStudent));
  const { activity, key, judge: mark } = handIn(runtime, "subjective-current");
  const handedIn = runtime.read(student, activity.activityId);
  assert.equal(handedIn.status, "completed");
  assert.equal(Object.hasOwn(handedIn, "assessment"), false);
  const pending = [essay, reflection].map(({ id: questionId, version: questionVersion }) => ({ questionId, questionVersion, status: "needsReview" }));
  const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
  assert.equal(recovered.assessment, "teacherReview");
  assert.deepEqual(recovered.review, { questions: pending });
  mark(essay.id, true);
  mark(reflection.id, false);
  const judged = runtime.read(student, activity.activityId);
  assert.equal(judged.status, "completed");
  assert.equal(Object.hasOwn(judged, "assessment"), false);
  assert.doesNotMatch(JSON.stringify(judged), leak);
  assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared").review, { questions: pending });
});

test("整卷主观题｜声明公布时交卷后显示待批且不含分数，教师判完每一题才公布教师成绩", t => {
  const runtime = open(t);
  runtime.publish(paper("subjective-scored", scoredStudent));
  const { activity, judge: mark } = handIn(runtime, "subjective-scored");
  const handedIn = runtime.read(student, activity.activityId);
  assert.equal(handedIn.status, "completed");
  assert.deepEqual(assessmentOf(handedIn), { status: "pending" });
  assert.doesNotMatch(JSON.stringify(handedIn), leak);
  mark(essay.id, true);
  const partly = runtime.read(student, activity.activityId);
  assert.deepEqual(assessmentOf(partly), { status: "pending" });
  assert.doesNotMatch(JSON.stringify(partly), leak);
  mark(reflection.id, false);
  assert.deepEqual(assessmentOf(runtime.read(student, activity.activityId)), { status: "complete", correctCount: 1, questionCount: 2 });
});

test("混合题组｜逐题交付在自动题已判、教师题未判时仍待批，教师判完后按教师判定计分", t => {
  const runtime = open(t);
  runtime.publish(mixedPaper("mixed-scored"));
  const activity = startPaper(runtime, "mixed-scored");
  deliver(runtime, activity, [judge], "question");
  const midway = runtime.read(student, activity.activityId);
  assert.equal(midway.status, "active");
  assert.equal(Object.hasOwn(midway, "assessment"), false);
  const mark = deliver(runtime, activity, [essay], "question");
  const handedIn = runtime.read(student, activity.activityId);
  assert.equal(handedIn.status, "completed");
  assert.deepEqual(assessmentOf(handedIn), { status: "pending" });
  assert.doesNotMatch(JSON.stringify(handedIn), leak);
  mark(essay.id, false);
  assert.deepEqual(assessmentOf(runtime.read(student, activity.activityId)), { status: "complete", correctCount: 1, questionCount: 2 });
});

test("题组交付公布成绩须每题都有评估或教师评阅，且仍不开放复盘", t => {
  const runtime = open(t);
  const partial = paper("partial-scored", scoredStudent, [essay, reflection], { teacherReview: { questionIds: [essay.id] } });
  rejects(runtime, partial, ["practice", "policy", "student", "passageScore"], "公布待批状态或成绩须每道题都声明评估或教师评阅");
  const review = { requires: "passageScore", while: "reviewOpen", byQuestion: ["effectiveVerdict"], byQuoteSet: [] } as const;
  rejects(runtime, paper("review-scored", { ...scoredStudent, review: { ...review, byQuestion: [...review.byQuestion], byQuoteSet: [] } }),
    ["practice", "policy"], "原值确认只支持回执与本人获准作答");
});

function correctCounts(value: unknown): number[] {
  return [...JSON.stringify(value).matchAll(/"correctCount":(\d+)/g)].map(([, count]) => Number(count));
}

test("混合整卷｜声明公布时学生回取不泄露自动判分，教师改判后学生只见读面这一份成绩", t => {
  const runtime = open(t);
  runtime.publish(mixedPaper("mixed-whole", false));
  const activity = startPaper(runtime, "mixed-whole");
  const mark = deliver(runtime, activity, [judge, essay], "whole");
  const key = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, operationId: "hand-in" } as const;
  const studentSees = () => [runtime.read(student, activity.activityId), runtime.recoverQuestionDelivery(student, activity.activityId, key),
    runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared")] as const;
  const [handedIn, recovered, declared] = studentSees();
  assert.deepEqual(assessmentOf(handedIn), { status: "pending" });
  assert.deepEqual(recovered.evaluation, { status: "withheld", evaluator });
  assert.equal(declared.assessment, "automatic");
  assert.doesNotMatch(JSON.stringify(studentSees()), leak);
  mark(essay.id, true);
  mark(judge.id, false);
  const [judged, ...recoveries] = studentSees();
  assert.deepEqual(assessmentOf(judged), { status: "complete", correctCount: 1, questionCount: 2 });
  assert.doesNotMatch(JSON.stringify(recoveries), leak);
  assert.deepEqual(correctCounts(studentSees()), [1]);
});
