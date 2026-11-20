import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { VerdictCommand, VerdictReceipt } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["race", "clear", "recover"]).parse(process.argv[2]);
const operationId = z.enum(["mark-a", "mark-b"]).parse(process.argv[3]);
const databasePath = "independent-delivery-assessment.sqlite";
const checkpoint = z.array(z.object({
  activityId: z.uuid(), assessment: z.enum(["none", "manual"]),
  receipt: z.strictObject({ id: z.uuid(), stepAttemptId: z.uuid(), slotId: z.string(), confirmedAt: z.string() }),
}));
const published = checkpoint.parse(JSON.parse(readFileSync("independent-delivery-assessment.json", "utf8")))
  .find(entry => entry.assessment === "manual");
assert.ok(published);
const { activityId, receipt } = published;
const questionId = "observation";
const questionVersion = 3;
const student = { role: "student", id: "observer" } as const;
const reviewer = { role: "reviewer", id: "observer-reviewer" } as const;
const key = { protocolVersion: 1, operationId: "confirm", stepAttemptId: receipt.stepAttemptId } as const;

let writeAllowed = true;
const authorizeQuestionDeliveryReview: NonNullable<Parameters<typeof openLearningRuntime>[0]["authorizeQuestionDeliveryReview"]> = scope =>
  scope.reviewerId === reviewer.id && scope.studentId === student.id && scope.activityId === activityId
  && scope.stepAttemptId === key.stepAttemptId && scope.operationId === key.operationId
  && scope.submissionId === receipt.id && scope.slotId === receipt.slotId;
const runtime = openLearningRuntime({
  databasePath,
  authorizeQuestionDeliveryReview,
  authorizeQuestionDeliveryVerdict: scope => writeAllowed && authorizeQuestionDeliveryReview(scope)
    && scope.targetId === "observe" && scope.questionId === questionId && scope.questionVersion === questionVersion,
  authorizeConfirmationRecovery: scope => scope.studentId === student.id && scope.operationId === key.operationId,
});

const first: VerdictCommand = {
  protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId,
  operationId, expectedRevision: 0, action: "override", correct: false, reason: "第一轮复核备注",
};
const second: VerdictCommand = { ...first, operationId: "next", expectedRevision: 1, correct: true };
const clear = (withdrawId: string): VerdictCommand => ({
  protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId,
  operationId: "clear", expectedRevision: 2, action: "withdraw", withdrawId, reason: "清除当前教师改判",
});

function write(command: VerdictCommand): VerdictReceipt {
  return runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, command);
}

function race() {
  try {
    const marked = write(first);
    assert.equal(marked.revision, 1);
    console.log("committed");
  } catch (error) {
    assert.ok(error instanceof LearningError);
    assert.equal(error.code, "VERDICT_CONFLICT");
    console.log(error.code);
  }
}

function verifyCleared() {
  const oldRead: ReturnType<typeof runtime.readQuestionDeliveryReview> = runtime.readQuestionDeliveryReview(reviewer, activityId, key);
  assert.equal(oldRead.basis.version, 2);
  assert.deepEqual(oldRead.questions, [{ questionId, questionVersion, status: "needsReview" }]);
  const reviewed = runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts");
  assert.ok(reviewed.assessment === "manual");
  assert.deepEqual(reviewed.basis, oldRead.basis);
  assert.deepEqual(reviewed.questions, [{ questionId, questionVersion, revision: 3, status: "needsReview" }]);
  const recovered = runtime.recoverQuestionDelivery(student, activityId, key, "declared");
  assert.deepEqual(recovered.receipt, receipt);
  assert.deepEqual(recovered.confirmation, reviewed.confirmation);
  assert.deepEqual(recovered.confirmation.questions[0]?.value, { body: "  混合物有明显分层。\n", title: "" });
  const view = runtime.read(student, activityId);
  assert.doesNotMatch(JSON.stringify({ recovered, view }), /teacherReview|第一轮复核备注|清除当前教师改判|核实观察/);
  using database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS n FROM submissions").get()?.n, 2);
  assert.equal(database.prepare("SELECT count(*) AS n FROM verdict_events WHERE submission_id = ?").get(receipt.id)?.n, 3);
}

try {
  if (phase === "race") {
    race();
  } else {
    if (phase === "clear") {
      const marked = write(first);
      const before = runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts");
      assert.deepEqual(before.questions, [{ questionId, questionVersion, revision: 1,
        status: "judged", effective: { source: "teacherReview", id: marked.id, correct: false } }]);
    }
    const later = write(second);
    assert.equal(later.revision, 2);
    const cleared = write(clear(later.id));
    assert.equal(cleared.revision, 3);
    assert.deepEqual(write(clear(later.id)), cleared);
    verifyCleared();
    writeAllowed = false;
    assert.throws(() => write(clear(later.id)), { code: "FORBIDDEN" });
    assert.equal(runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts").questions[0]?.revision, 3);
    console.log(`独立题组判定宿主 ${phase} 通过`);
  }
} finally { runtime.close(); }
