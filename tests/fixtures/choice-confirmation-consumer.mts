import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { ChoiceConfirmationInput } from "learning-kernel";

const [, , mode, operationId] = process.argv;
assert.ok(operationId);
const student = { role: "student", id: "library-club-owner" } as const;
const { activityId, stepAttemptId } = z.object({ activityId: z.uuid(), stepAttemptId: z.uuid() })
  .parse(JSON.parse(readFileSync("receipt.json", "utf8")));
const input: ChoiceConfirmationInput = {
  protocolVersion: 1, stepAttemptId, operationId, slotId: "choices", questions: [
    { questionId: "q1", questionVersion: 1, revision: 3, original: { state: "none" } },
    { questionId: "q2", questionVersion: 1, revision: 1, original: { state: "none" } },
  ],
};
const runtime = openLearningRuntime({
  databasePath: "learning.sqlite",
  verifyOriginal: scope => scope.studentId === student.id && scope.activityId === activityId && scope.original.state === "none",
  authorizeConfirmationRecovery: scope => scope.studentId === student.id && scope.activityId === activityId && scope.operationId === operationId,
});
try {
  if (mode === "race") {
    try {
      runtime.confirmChoices(student, activityId, input);
      runtime.evaluatePending();
      console.log("committed");
    } catch (error) {
      if (!(error instanceof LearningError) || error.code !== "ALREADY_SUBMITTED") throw error;
      console.log("closed");
    }
  } else {
    assert.equal(mode, "recover");
    const recovered = runtime.recoverChoiceConfirmation(student, activityId, { protocolVersion: 1, stepAttemptId, operationId });
    assert.equal(recovered.receipt.stepAttemptId, stepAttemptId);
    assert.deepEqual(recovered.practice, { id: "library-club", version: 1 });
    assert.deepEqual(recovered.confirmation.questions.map(({ questionId, revision, choice }) => [questionId, revision, choice]),
      [["q1", 3, "2"], ["q2", 1, "0"]]);
    assert.deepEqual(runtime.confirmChoices(student, activityId, input), recovered.receipt);
    const view = runtime.read(student, activityId);
    assert.equal(view.status, "completed");
    assert.deepEqual(view.submission, { receipt: recovered.receipt, confirmation: recovered.confirmation });
    assert.throws(() => runtime.confirmChoices({ ...student, id: "other" }, activityId, input), { code: "FORBIDDEN" });
  }
} finally {
  runtime.close();
}
