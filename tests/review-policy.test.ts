import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { startActivity } from "../src/kernel/activity.ts";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput, ReviewAccess } from "../src/server.ts";
import { booleanEvaluator } from "./fixtures/evaluators.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

type ReadingInput = Extract<PublicationInput, { practice: { formatVersion: 1 } }>;
type Reviewer = ReadingInput["practice"]["policy"]["reviewer"];

const student = { role: "student", id: "policy-student" } as const;
const teacher = { role: "reviewer", id: "policy-teacher" } as const;
const slotId = "work";
const judge = { id: "judge", version: 2, prompt: "判断。", response: "booleanOrString", options: { yes: "是", no: "否" } };
const evaluator = { id: "policy-judge", version: 1 };
const keyRef = { id: "policy-key", version: 1 };

function publication(id: string, reviewer: Reviewer, manager: string[] = []): ReadingInput {
  return {
    practice: {
      id, version: 1, formatVersion: 1, title: "评阅策略", goals: { judge: "完成判断" }, questions: [judge],
      steps: [{
        id: "judge", instructions: "判断。", tool: { id: "question-delivery", version: 1 }, inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { [slotId]: {
          type: "questionDelivery", source: "questions", targetId: "judge", delivery: { mode: "whole" }, confirmFromDrafts: { allowUnanswered: false },
        } } },
        afterConfirmation: "finish",
      }],
      grading: { assessment: { from: { stepId: "judge", slotId }, evaluator, keyRef, unit: "question",
        effectiveVerdictOrder: ["teacherReview", "automatic"] } },
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
        reviewer, manager: { scope: "assigningTeacher", actions: manager.filter(action => action === "openReview") },
      },
    },
    scoringKey: { ...keyRef, acceptedByQuestion: { [judge.id]: { response: "booleanOrString", acceptedResponse: true } } },
  };
}

function reviewer(fields: Reviewer["fields"], actions: Reviewer["actions"] = []): Reviewer {
  return { scope: "assignedReviewer", fields, actions };
}

function hand(runtime: ReturnType<typeof openLearningRuntime>, database: DatabaseSync, practiceId: string, assigned?: string) {
  const opening = { protocolVersion: 1 as const, operationId: "open-" + practiceId + (assigned ? "-assigned" : ""), practiceId, practiceVersion: 1 };
  const activity = assigned ? startActivity(database, student.id, opening, () => new Date(), assigned) : runtime.start(student, opening);
  const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
    slotId, questionId: judge.id, questionVersion: judge.version, operationId: "save", baseRevision: 0, value: false });
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
    slotId, source: "whole", operationId: "hand-in",
    questions: [{ questionId: judge.id, questionVersion: judge.version, revision: saved.revision, original: { state: "uncollected" } }] });
  runtime.evaluatePending();
  const key = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, operationId: "hand-in" };
  const override = { protocolVersion: 1 as const, submissionId: receipt.id, targetId: "judge", questionId: judge.id, operationId: "mark-" + practiceId,
    expectedRevision: 0, action: "override" as const, correct: true, reason: "复核" };
  return { activityId: activity.activityId, key, override };
}

test("新评阅入口服从练法声明的 policy.reviewer：未声明即拒绝，字段逐项收窄，改判须声明动作", t => {
  const databasePath = scenarioDatabase(t);
  const seen: ReviewAccess[] = [];
  const runtime = openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    evaluators: [booleanEvaluator(evaluator, ({ value, acceptedResponse }) => ({ status: "judged", correct: value === acceptedResponse }))],
    authorizeReview: access => { seen.push(access); return true; } });
  const forbidden = { status: 403, code: "FORBIDDEN" };
  try {
    using database = new DatabaseSync(databasePath);
    runtime.publish(publication("closed", reviewer([])));
    const closed = hand(runtime, database, "closed");
    assert.throws(() => runtime.readQuestionDeliveryReview(teacher, closed.activityId, closed.key, "verdicts"), forbidden);
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(teacher, closed.activityId, closed.key, closed.override), forbidden);
    assert.equal(seen.length, 0);

    runtime.publish(publication("answers-only", reviewer(["studentChoices"])));
    const answers = hand(runtime, database, "answers-only");
    const answerView = runtime.readQuestionDeliveryReview(teacher, answers.activityId, answers.key, "verdicts");
    assert.deepEqual(answerView.confirmation.questions.map(({ value }) => value), [false]);
    assert.deepEqual(answerView.questions, [{ questionId: judge.id, questionVersion: judge.version, revision: 0, status: "judged" }]);
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(teacher, answers.activityId, answers.key, answers.override), forbidden);
    assert.deepEqual(seen.map(({ purpose, delivery }) => [purpose, delivery]), [["readReview", "questionDelivery"]]);

    runtime.publish(publication("grader", reviewer(["gradingBasis", "verdictHistory"], ["reviseQuestionVerdict"])));
    const grader = hand(runtime, database, "grader");
    const marked = runtime.writeQuestionDeliveryVerdict(teacher, grader.activityId, grader.key, grader.override);
    const graderView = runtime.readQuestionDeliveryReview(teacher, grader.activityId, grader.key, "verdicts");
    assert.equal(Object.hasOwn(graderView.confirmation.questions[0] ?? {}, "value"), false);
    const [state] = graderView.questions;
    assert.ok(state?.status === "judged");
    assert.deepEqual(state.effective, { source: "teacherReview", id: marked.id, correct: true });
    assert.deepEqual(state.automatic, { correct: false, valid: true });
    assert.deepEqual(state.history?.map(({ id, action, correct }) => [id, action, correct]), [[marked.id, "override", true]]);
    const revision = seen.at(-2);
    assert.ok(revision?.purpose === "reviseVerdict");
    assert.deepEqual([revision.delivery, revision.targetId, revision.questionId, revision.questionVersion, revision.action],
      ["questionDelivery", "judge", judge.id, judge.version, "override"]);
  } finally { runtime.close(); }
});

test("原值确认卷可在发布时声明评阅字段与改判，不得声明两步阅读专属的引文评语或复盘管理", t => {
  const runtime = openLearningRuntime({ databasePath: scenarioDatabase(t),
    evaluators: [booleanEvaluator(evaluator, () => ({ status: "needsReview" }))] });
  try {
    runtime.publish(publication("declared", reviewer(["studentChoices", "verdictHistory", "gradingBasis"], ["reviseQuestionVerdict"])));
    for (const [id, policy, manager] of [
      ["quotes", reviewer(["submittedQuotes"]), []], ["comments", reviewer([], ["commentOnQuotes"]), []],
      ["manager", reviewer(["gradingBasis"]), ["openReview"]],
    ] as const) {
      assert.throws(() => runtime.publish(publication(id, policy, [...manager])), error => error instanceof ZodError
        && error.issues.some(issue => issue.message === "原值确认的评阅只声明学生原答、判定历史、评阅依据与逐题改判"));
    }
  } finally { runtime.close(); }
});

test("评阅归属：有内核指派时以指派为准，无指派时交宿主授权钩子裁决，未配置钩子即拒绝", t => {
  const databasePath = scenarioDatabase(t);
  let hostAllows = true;
  const settings = { databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    evaluators: [booleanEvaluator(evaluator, () => ({ status: "needsReview" }))] };
  const runtime = openLearningRuntime({ ...settings, authorizeReview: () => hostAllows });
  const forbidden = { status: 403, code: "FORBIDDEN" };
  try {
    using database = new DatabaseSync(databasePath);
    runtime.publish(publication("ownership", reviewer(["studentChoices"], ["reviseQuestionVerdict"])));
    const assigned = hand(runtime, database, "ownership", teacher.id);
    const outsider = { ...teacher, id: "substitute-teacher" };
    assert.throws(() => runtime.readQuestionDeliveryReview(outsider, assigned.activityId, assigned.key, "verdicts"), forbidden);
    assert.ok(runtime.readQuestionDeliveryReview(teacher, assigned.activityId, assigned.key, "verdicts"));
    hostAllows = false;
    assert.throws(() => runtime.readQuestionDeliveryReview(teacher, assigned.activityId, assigned.key, "verdicts"), forbidden);
    hostAllows = true;

    const delegated = hand(runtime, database, "ownership");
    assert.ok(runtime.readQuestionDeliveryReview(outsider, delegated.activityId, delegated.key, "verdicts"));
    hostAllows = false;
    assert.throws(() => runtime.readQuestionDeliveryReview(outsider, delegated.activityId, delegated.key, "verdicts"), forbidden);
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(outsider, delegated.activityId, delegated.key, delegated.override), forbidden);
  } finally { runtime.close(); }
  const unconfigured = openLearningRuntime(settings);
  try {
    const { activityId, stepAttemptId } = unconfigured.start(student, { protocolVersion: 1, operationId: "open-ownership",
      practiceId: "ownership", practiceVersion: 1 });
    const key = { protocolVersion: 1 as const, stepAttemptId, operationId: "hand-in" };
    assert.throws(() => unconfigured.readQuestionDeliveryReview(teacher, activityId, key, "verdicts"), forbidden);
  } finally { unconfigured.close(); }
});
