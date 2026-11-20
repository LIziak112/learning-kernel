import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openLearningRuntime } from "learning-kernel";
import type { PublicationInput } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["write", "recover"]).parse(process.argv[2]);
const student = { role: "student", id: "observer" } as const;
const reviewer = { role: "reviewer", id: "observer-reviewer" } as const;
const questionId = "observation";
const questionVersion = 3;
const slotId = "work";
const criteria = { id: "private-observation-criteria", version: 2, reviewCriteria: "核实观察是否支持结论。" };
const keyRef = { id: criteria.id, version: criteria.version };
const value = { body: "  混合物有明显分层。\n", title: "" };

const receiptSchema = z.strictObject({ id: z.uuid(), stepAttemptId: z.uuid(), slotId: z.string(), confirmedAt: z.string() });
const checkpoint = z.array(z.strictObject({
  activityId: z.uuid(), assessment: z.enum(["none", "manual"]), receipt: receiptSchema,
})).length(2);
const databasePath = "independent-delivery-assessment.sqlite";
const checkpointFile = "independent-delivery-assessment.json";
let approval = true;
const runtime = openLearningRuntime({
  databasePath,
  authorizeConfirmationRecovery: scope => approval && scope.studentId === student.id && scope.operationId === "confirm",
  authorizeQuestionDeliveryReview: scope => approval && scope.reviewerId === reviewer.id && scope.studentId === student.id
    && scope.operationId === "confirm" && scope.slotId === slotId,
});

function publication(id: string) {
  return {
    practice: {
      id, version: 1, formatVersion: 1, title: "独立观察活动",
      goals: { observe: "保留原始观察" },
      questions: [{ id: questionId, version: questionVersion, prompt: "记录一次观察。", response: "textWithOptionalTitle" }],
      steps: [{
        id: "answer", instructions: "保存并提交。", tool: { id: "question-delivery", version: 1 },
        inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { [slotId]: {
          type: "questionDelivery", source: "questions", targetId: "observe",
          delivery: { mode: "whole" }, confirmFromDrafts: { allowUnanswered: false },
        } } },
        afterConfirmation: "finish",
      }],
      grading: {},
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  } satisfies PublicationInput;
}

function key(stepAttemptId: string) {
  return { protocolVersion: 1, operationId: "confirm", stepAttemptId } as const;
}

function input(stepAttemptId: string) {
  return { ...key(stepAttemptId), slotId, source: "whole",
    questions: [{ questionId, questionVersion, revision: 1, original: { state: "uncollected" } }],
  } as const satisfies Parameters<typeof runtime.confirmQuestionDelivery>[2];
}

function write() {
  const saved = (["none", "manual"] as const).map(assessment => {
    const id = "observations-" + assessment;
    const base = publication(id);
    runtime.publish(assessment === "manual" ? {
      practice: { ...base.practice, grading: { manualReview: { keyRef } } }, scoringKey: criteria,
    } : base);
    const { activityId, stepAttemptId } = runtime.start(student, { protocolVersion: 1, practiceId: id, practiceVersion: 1, operationId: "start-" + assessment });
    const draft = runtime.saveQuestionDeliveryDraft(student, activityId, {
      protocolVersion: 1, stepAttemptId, slotId, questionId, questionVersion, operationId: "save", baseRevision: 0, value,
    });
    assert.equal(draft.revision, 1);
    const receipt = runtime.confirmQuestionDelivery(student, activityId, input(stepAttemptId));
    return { activityId, assessment, receipt };
  });
  writeFileSync(checkpointFile, JSON.stringify(saved));
}

function recover() {
  const confirmed = checkpoint.parse(JSON.parse(readFileSync(checkpointFile, "utf8")));
  for (const { activityId, assessment, receipt } of confirmed) {
    const { stepAttemptId } = receipt;
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activityId, input(stepAttemptId)), receipt);
    const result = runtime.recoverQuestionDelivery(student, activityId, key(stepAttemptId), "declared");
    assert.equal(result.assessment, assessment);
    assert.deepEqual(result.receipt, receipt);
    assert.deepEqual(result.confirmation.questions[0]?.value, value);
    assert.doesNotMatch(JSON.stringify(result), /reviewCriteria|private-observation-criteria|核实观察|"evaluation"/);
    const view = runtime.read(student, activityId);
    assert.ok("questionDeliveries" in view);
    assert.equal(view.status, "completed");
    assert.deepEqual(view.questionDeliveries, [{ receipt, questionDelivery: result.confirmation }]);
    assert.doesNotMatch(JSON.stringify(view), /reviewCriteria|private-observation-criteria|核实观察|needsReview/);
    if (result.assessment === "manual") {
      const review = runtime.readQuestionDeliveryReview(reviewer, activityId, key(stepAttemptId));
      assert.deepEqual(review.basis, criteria);
      assert.deepEqual(review.confirmation, result.confirmation);
      assert.deepEqual(review.questions, [{ questionId, questionVersion, status: "needsReview" }]);
      assert.deepEqual(review.questions, result.review.questions);
    } else {
      assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activityId, key(stepAttemptId)), { code: "REVIEW_NOT_FOUND" });
    }
    approval = false;
    assert.throws(() => runtime.recoverQuestionDelivery(student, activityId, key(stepAttemptId), "declared"), { code: "FORBIDDEN" });
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activityId, key(stepAttemptId)), { code: "FORBIDDEN" });
    approval = true;
  }
  using db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM evaluation_tasks WHERE status = 'pending'").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM response_review_requirements").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM automatic_verdicts").get()?.n, 0);
}

try {
  if (phase === "write") write();
  else recover();
  console.log(`独立题组可选评估宿主 ${phase} 通过`);
} finally { runtime.close(); }
