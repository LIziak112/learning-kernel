import { strict as assert } from "node:assert";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { ChoiceConfirmationInput, ChoiceDraftAmendmentInput, ChoiceDraftAmendmentScope } from "learning-kernel";

const [, , phase, outcome] = process.argv;
const student = { role: "student", id: "amendment-student" } as const;
const teacher = { role: "reviewer", id: "amendment-teacher" } as const;
const other = { ...teacher, id: "unassigned" };
const runtime = openLearningRuntime({ databasePath: "learning.sqlite",
  authorizeConfirmationRecovery: scope => scope.studentId === student.id,
  authorizeChoiceDraftAmendment: scope => scope.reviewerId === teacher.id && scope.studentId === student.id && scope.questionId === "q1",
});
try {
  const opened = runtime.start(student, {
    protocolVersion: 1, practiceId: "library-club", practiceVersion: 1, operationId: phase?.startsWith("race-") ? "concurrent-amendment" : "amendment-activity",
  });
  const scope: ChoiceDraftAmendmentScope = { protocolVersion: 1, stepAttemptId: opened.stepAttemptId, slotId: "choices",
    questionId: "q1", questionVersion: 1 };
  const amendment: ChoiceDraftAmendmentInput = { ...scope, choice: "1", baseRevision: 0, operationId: "first-correction", reason: "更正误录" };
  const amend = (input: ChoiceDraftAmendmentInput) => runtime.amendChoiceDraft(teacher, opened.activityId, input);
  const teacherRead = () => runtime.readChoiceDraftForAmendment(teacher, opened.activityId, scope);
  const reply = { slotId: scope.slotId, questionId: scope.questionId, questionVersion: 1, choice: "1", revision: 1, changeCount: 0 };
  const evidence = (revision: number): ChoiceConfirmationInput => ({
    protocolVersion: 1, operationId: "confirm", stepAttemptId: opened.stepAttemptId, slotId: scope.slotId,
    questions: [{ questionId: "q1", questionVersion: 1, revision, original: { state: "uncollected" } },
      { questionId: "q2", questionVersion: 1, revision: 0, original: { state: "uncollected" } }],
  });
  const confirm = (revision: number) => runtime.confirmChoices(student, opened.activityId, evidence(revision));
  if (phase === "race-prepare") {
    assert.equal(teacherRead().revision, 0);
  } else if (phase === "race-amend") {
    console.log(compete(() => amend(amendment), "amended", "ALREADY_SUBMITTED"));
  } else if (phase === "race-confirm") {
    console.log(compete(() => confirm(0), "confirmed", "ANSWER_REVISION_CONFLICT"));
  } else if (phase === "race-recover") {
    const expectation = outcome === "amended" ? 1 : 0;
    if (expectation === 1) assert.deepEqual(amend(amendment), reply);
    else assert.throws(() => amend(amendment), { code: "ALREADY_SUBMITTED" });
    const receipt = confirm(expectation);
    const recovered = runtime.recoverChoiceConfirmation(student, opened.activityId, {
      protocolVersion: 1, stepAttemptId: opened.stepAttemptId, operationId: "confirm",
    });
    assert.equal(recovered?.receipt.id, receipt.id);
    assert.deepEqual(recovered?.confirmation.questions.map(q => [q.revision, q.choice]), [[expectation, expectation ? "1" : null], [0, null]]);
  } else if (phase === "write") {
    assert.equal("choiceDrafts" in runtime.read(student, opened.activityId), false);
    assert.deepEqual(amend(amendment), reply);
    assert.deepEqual(teacherRead(), reply);
    assert.equal(runtime.readChoiceDraftActivity(student, opened.activityId), undefined);
  } else {
    assert.equal(phase, "recover");
    const view = runtime.read(student, opened.activityId);
    assert.ok("choiceDrafts" in view);
    assert.deepEqual(view.choiceDrafts, [reply]);
    assert.deepEqual(teacherRead(), reply);
    assert.deepEqual(amend(amendment), reply);
    assert.throws(() => amend({ ...amendment, reason: "另一理由" }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => runtime.amendChoiceDraft(other, opened.activityId, amendment), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => runtime.readChoiceDraftForAmendment(other, opened.activityId, scope), { status: 403, code: "FORBIDDEN" });
    const saved = runtime.saveCurrentChoiceDraft(student, opened.activityId, { ...scope, baseRevision: 1, operationId: "student", choice: "0" });
    assert.deepEqual([saved.revision, saved.changeCount], [2, 1]);
    const teacherAgain = { ...amendment, baseRevision: 2, operationId: "second-correction" };
    const corrected = amend(teacherAgain);
    assert.deepEqual([corrected.revision, corrected.changeCount], [3, 1]);
    assert.deepEqual(teacherRead(), corrected);
    assert.deepEqual(runtime.saveChoiceDraft(student, opened.activityId, { ...scope, baseRevision: 1, operationId: "student", choice: "0" }), saved);
    assert.throws(() => runtime.saveCurrentChoiceDraft(student, opened.activityId, {
      ...scope, baseRevision: 3, operationId: "student", choice: "1",
    }, "replayLatestOnly"), { code: "DRAFT_REPLAY_REQUIRED" });
    const receipt = confirm(3);
    assert.equal(receipt.stepAttemptId, scope.stepAttemptId);
    assert.throws(() => amend({ ...teacherAgain, operationId: "too-late", baseRevision: 3 }), { code: "ALREADY_SUBMITTED" });
    assert.deepEqual(amend(teacherAgain), corrected);
    assert.deepEqual(amend(amendment), reply);
  }
} finally {
  runtime.close();
}

function compete(perform: () => unknown, success: string, conflict: string) {
  try {
    perform();
    return success;
  } catch (error) {
    if (error instanceof LearningError && error.code === conflict) return conflict;
    throw error;
  }
}
