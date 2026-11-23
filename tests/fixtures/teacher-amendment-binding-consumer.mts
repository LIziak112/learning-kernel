import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { openLearningRuntime, verifyActivityBindings } from "learning-kernel";
import type { ActivityBindingClaims, ChoiceDraftAmendmentInput, ChoiceSnapshotRevisionInput, PublicationInput, TeacherAmendmentBinding } from "learning-kernel";

const alice = { role: "student", id: "alice" } as const;
const bob = { role: "student", id: "bob" } as const;
const teacher = { role: "reviewer", id: "teacher" } as const;
const evaluator = { id: "arithmetic-assessment", version: 1 };
const reference = { id: "arith-key", version: 1 };
const declaration = {
  scoringKey: { ...reference, acceptedChoices: { first: "1", second: "1" } },
  practice: {
    formatVersion: 1, id: "arithmetic-round", version: 1, title: "Arithmetic", goals: { arithmetic: "Compute" },
    questions: [{ id: "first", version: 1, prompt: "2 + 3?", options: { "0": "4", "1": "5" } },
      { id: "second", version: 1, prompt: "2 × 4?", options: { "0": "6", "1": "8" } }],
    steps: [{ id: "answer", instructions: "Choose one", tool: { id: "single-choice-group", version: 1 },
      inputs: { questions: { from: "questions" } }, submit: { purpose: "finalAnswer", slots: {
        answers: { type: "oneChoicePerQuestion", source: "questions", targetId: "arithmetic", confirmFromDrafts: { allowUnanswered: true } },
      } }, afterConfirmation: "finish" }],
    grading: { assessment: { from: { stepId: "answer", slotId: "answers" }, evaluator, keyRef: reference,
      unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"] } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  },
} satisfies PublicationInput;

const working = "amendment-backup.sqlite";
const early = "amendment-before.sqlite";
const afterAnswer = "amendment-answer.sqlite";
const afterSnapshot = "amendment-snapshot.sqlite";
const afterSave = "amendment-student-save.sqlite";
const late = "amendment-late.sqlite";
const open = { protocolVersion: 1, practiceId: declaration.practice.id, practiceVersion: 1, operationId: "opening" } as const;
const options = { databasePath: working, authorizeChoiceDraftAmendment: () => true, authorizeChoiceSnapshotRevision: () => true,
  evaluators: [{ ...evaluator, responseTypes: ["choice"], evaluate: () => ({ status: "judged" as const, correct: true }) }],
};
type Student = typeof alice | typeof bob;
function withRuntime<T>(operation: (runtime: ReturnType<typeof openLearningRuntime>) => T) {
  const runtime = openLearningRuntime(options);
  try {
    return operation(runtime);
  } finally {
    runtime.close();
  }
}

const students = withRuntime(runtime => {
  runtime.publish(declaration);
  return [alice, bob].map(student => ({ studentId: student.id, ...runtime.start(student, open) }));
});
const [mine, peer] = students;
assert.ok(mine && peer);
copyFileSync(working, early);

const target = { slotId: "answers", questionId: "first" };
const answer: ChoiceDraftAmendmentInput = { ...target, protocolVersion: 1, stepAttemptId: mine.stepAttemptId,
  questionVersion: 1, operationId: "correct-answer", baseRevision: 0, choice: "1", reason: "Transcription" };
const snapshot: ChoiceSnapshotRevisionInput = { ...target, protocolVersion: 1, stepAttemptId: peer.stepAttemptId,
  questionVersion: 1, operationId: "correct-question", baseRevision: 0, prompt: "3 + 2?", options: { "0": "5", "1": "6" },
  acceptedChoice: "0", reason: "Corrected the options" };
function binding(kind: TeacherAmendmentBinding["kind"], student: Student, activityId: string,
  input: ChoiceDraftAmendmentInput | ChoiceSnapshotRevisionInput): TeacherAmendmentBinding {
  const { operationId, baseRevision, stepAttemptId, slotId, questionId } = input;
  return { kind, studentId: student.id, activityId, stepAttemptId, slotId, questionId, reviewerId: teacher.id, operationId,
    revision: baseRevision + 1 };
}

const first = binding("answer", alice, mine.activityId, answer);
withRuntime(runtime => assert.equal(runtime.amendChoiceDraft(teacher, mine.activityId, answer).revision, first.revision));
copyFileSync(working, afterAnswer);
const second = binding("snapshot", bob, peer.activityId, snapshot);
withRuntime(runtime => assert.equal(runtime.reviseChoiceSnapshot(teacher, peer.activityId, snapshot).revision, second.revision));
copyFileSync(working, afterSnapshot);
const dismissed = { ...answer, questionId: "second", operationId: "pending-after-student" };
withRuntime(runtime => runtime.saveChoiceDraft(alice, mine.activityId, {
  ...target, protocolVersion: 1, stepAttemptId: mine.stepAttemptId, questionId: dismissed.questionId, questionVersion: 1,
  baseRevision: 0, choice: "1", operationId: "student-choice",
}));
copyFileSync(working, afterSave);
const pending = binding("answer", alice, mine.activityId, dismissed);
const later = { ...answer, baseRevision: 1, operationId: "second-answer", choice: "0" };
const revisedAnswer = { ...answer, stepAttemptId: peer.stepAttemptId, questionVersion: 2, baseRevision: 1, operationId: "after-snapshot", choice: "0" };
const third = binding("answer", alice, mine.activityId, later);
const fourth = binding("answer", bob, peer.activityId, revisedAnswer);
withRuntime(runtime => {
  assert.equal(runtime.amendChoiceDraft(teacher, mine.activityId, later).revision, third.revision);
  assert.equal(runtime.amendChoiceDraft(teacher, peer.activityId, revisedAnswer).revision, fourth.revision);
  runtime.confirmChoices(bob, peer.activityId, {
    protocolVersion: 1, stepAttemptId: peer.stepAttemptId, operationId: "confirmed", slotId: target.slotId,
    questions: [{ questionId: "first", questionVersion: 2, revision: 2, original: { state: "uncollected" } },
      { questionId: "second", questionVersion: 1, revision: 0, original: { state: "uncollected" } }],
  });
  runtime.evaluatePending();
});
copyFileSync(working, late);

const original: ActivityBindingClaims = { protocolVersion: 1,
  bindings: students.map(({ activityId, studentId }) => ({ activityId, studentId, operationId: open.operationId })), openingIntents: [] };
const files = [early, afterAnswer, afterSnapshot, afterSave, late];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const bytes = files.map(digest);
for (const path of files) assert.equal(verifyActivityBindings(path, original), undefined);
console.log("Opening bindings alone accept the physical cuts before and after actual answer and question amendments");

const claims = (completed: TeacherAmendmentBinding[], waiting: TeacherAmendmentBinding[] = []) =>
  ({ ...original, teacherAmendments: { completed, pending: waiting } });
const mismatch = { status: 409, code: "TEACHER_AMENDMENTS_MISMATCH" };
assert.equal(verifyActivityBindings(early, claims([])), undefined);
assert.equal(verifyActivityBindings(afterAnswer, claims([first])), undefined);
assert.equal(verifyActivityBindings(afterSnapshot, claims([first, second])), undefined);
assert.equal(verifyActivityBindings(late, claims([first, second, third, fourth])), undefined);
assert.throws(() => verifyActivityBindings(afterAnswer, claims([])), mismatch);
assert.throws(() => verifyActivityBindings(early, claims([first])), mismatch);
assert.throws(() => verifyActivityBindings(afterSnapshot, claims([first])), mismatch);
assert.throws(() => verifyActivityBindings(afterAnswer, claims([first, second])), mismatch);
assert.throws(() => verifyActivityBindings(late, claims([second, third, fourth])), mismatch);
assert.equal(verifyActivityBindings(early, claims([], [first])), undefined);
assert.equal(verifyActivityBindings(afterAnswer, claims([], [first])), undefined);
assert.equal(verifyActivityBindings(afterAnswer, claims([first], [second])), undefined);
assert.equal(verifyActivityBindings(afterSnapshot, claims([first], [second])), undefined);
assert.equal(verifyActivityBindings(afterSave, claims([first, second], [pending])), undefined);
assert.throws(() => verifyActivityBindings(afterAnswer, claims([first], [first])), mismatch);
assert.throws(() => verifyActivityBindings(late, claims([first, second, third, { ...fourth, revision: 1 }])), mismatch);
for (const wrong of [
  { ...first, kind: "snapshot" as const }, { ...first, reviewerId: "someone-else" }, { ...first, studentId: bob.id },
  { ...first, questionId: dismissed.questionId }, { ...first, operationId: "other-operation" },
]) {
  assert.throws(() => verifyActivityBindings(afterAnswer, claims([wrong])), mismatch);
}
for (const wrong of [{ ...pending, slotId: "other-slot" }, { ...pending, questionId: "unknown" },
  { ...pending, studentId: bob.id }, { ...pending, stepAttemptId: peer.stepAttemptId }]) {
  assert.throws(() => verifyActivityBindings(afterSave, claims([first, second], [wrong])), mismatch);
}
assert.deepEqual(files.map(digest), bytes);
