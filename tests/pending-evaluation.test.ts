import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput } from "../src/server.ts";
import { booleanEvaluator } from "./fixtures/evaluators.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "pending-student" } as const;
const reviewer = { role: "reviewer", id: "pending-reviewer" } as const;
const slotId = "work";
const judge = { id: "judge", version: 3, prompt: "这句话成立吗？", response: "booleanOrString", options: { yes: "是", no: "否" } };
const evaluator = { id: "fragile-judge", version: 1 };
const keyRef = { id: "fragile-key", version: 1 };
const publication = {
  practice: {
    id: "fragile", version: 1, formatVersion: 1, title: "评估失败兜底", goals: { judge: "完成判断" }, questions: [judge],
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
      reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] }, manager: { scope: "assigningTeacher", actions: [] },
    },
  },
  scoringKey: { ...keyRef, acceptedByQuestion: { [judge.id]: { response: "booleanOrString", acceptedResponse: true } } },
} satisfies PublicationInput;

test("恢复只读；评估器连续失败三次转失败终态，学生见失败、教师见评估失败并可人工改判；评估可按提交号限定", t => {
  const databasePath = scenarioDatabase(t);
  let broken = true;
  let calls = 0;
  const runtime = openLearningRuntime({
    databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: () => true,
    evaluators: [booleanEvaluator(evaluator, ({ value, acceptedResponse }) => {
      calls++;
      if (broken) throw new Error("upstream grader down");
      return { status: "judged", correct: value === acceptedResponse };
    })],
  });
  try {
    runtime.publish(publication);
    const confirm = (operationId: string) => {
      const activity = runtime.start(student, { protocolVersion: 1, operationId, practiceId: "fragile", practiceVersion: 1 });
      const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
        slotId, questionId: judge.id, questionVersion: judge.version, operationId: "save", baseRevision: 0, value: true });
      const input = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, slotId, source: "whole" as const, operationId: "hand-in",
        questions: [{ questionId: judge.id, questionVersion: judge.version, revision: saved.revision, original: { state: "uncollected" as const } }] };
      const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
      return { activity, receipt, key: { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, operationId: "hand-in" } };
    };
    const first = confirm("first");
    const second = confirm("second");
    using database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    for (const table of ["evaluation_tasks", "automatic_verdicts", "response_review_requirements"]) {
      for (const action of ["INSERT", "UPDATE"]) {
        database.exec(`CREATE TRIGGER block_${action}_${table} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'read path wrote'); END`);
      }
    }
    const pendingView = runtime.recoverQuestionDelivery(student, first.activity.activityId, first.key);
    assert.deepEqual(pendingView.evaluation, { status: "pending", evaluator });
    assert.equal(calls, 0);
    for (const table of ["evaluation_tasks", "automatic_verdicts", "response_review_requirements"]) {
      for (const action of ["INSERT", "UPDATE"]) database.exec(`DROP TRIGGER block_${action}_${table}`);
    }
    const scope = { submissionId: first.receipt.id };
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 1, deferred: 0 });
    assert.equal(calls, 3);
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
    assert.equal(calls, 3);
    assert.deepEqual({ ...database.prepare("SELECT status, attempts, last_error FROM evaluation_tasks WHERE submission_id = ?").get(first.receipt.id) },
      { status: "failed", attempts: 3, last_error: "EVALUATOR_FAILED" });
    assert.equal(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(second.receipt.id)?.status, "pending");
    assert.deepEqual(runtime.recoverQuestionDelivery(student, first.activity.activityId, first.key).evaluation, { status: "failed", evaluator });
    assert.doesNotMatch(JSON.stringify(runtime.read(student, first.activity.activityId)), /upstream grader|EVALUATOR_FAILED/);

    const review = runtime.readQuestionDeliveryReview(reviewer, first.activity.activityId, first.key, "verdicts");
    assert.deepEqual(review.questions, [{ questionId: judge.id, questionVersion: judge.version, revision: 0, status: "evaluationFailed" }]);
    const marked = runtime.writeQuestionDeliveryVerdict(reviewer, first.activity.activityId, first.key, {
      protocolVersion: 1, submissionId: first.receipt.id, targetId: "judge", questionId: judge.id, operationId: "manual-fallback",
      expectedRevision: 0, action: "override", correct: true, reason: "评估服务失败，人工判定",
    });
    assert.deepEqual(runtime.readQuestionDeliveryReview(reviewer, first.activity.activityId, first.key, "verdicts").questions, [{
      questionId: judge.id, questionVersion: judge.version, revision: 1, status: "judged",
      effective: { source: "teacherReview", id: marked.id, correct: true },
    }]);

    broken = false;
    assert.deepEqual(runtime.evaluatePending(), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
    const done = runtime.recoverQuestionDelivery(student, second.activity.activityId, second.key);
    assert.ok(done.evaluation.status === "evaluated");
    assert.equal(done.evaluation.correctCount, 1);
    assert.equal(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(first.receipt.id)?.status, "failed");
  } finally { runtime.close(); }
});
