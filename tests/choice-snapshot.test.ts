import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startActivity } from "../src/kernel/activity.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { saveDraft } from "../src/kernel/submission.ts";
import { ChoiceDraftConflict, ChoiceSnapshotRevisionConflict, LearningError, openLearningRuntime } from "../src/server.ts";
import type { ChoiceSnapshotRevisionInput, ChoiceSnapshotReviewerScope, PublicationInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "author" } as const;
const teacher = { role: "reviewer", id: "adviser" } as const;
const opening = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;
const evaluator = { id: "snapshot-key", version: 1 };
const [first, second] = questions;
assert.ok(first && second);
const firstId = first.id;
const secondId = second.id;
const { practice } = frozenChoicePublication;
const [step] = practice.steps;
const publication = { ...frozenChoicePublication, practice: {
  ...practice, questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })),
  grading: { assessment: { ...practice.grading.assessment, evaluator } },
  steps: [{ ...step, submit: { ...step.submit, slots: {
    answers: { ...step.submit.slots.answers, confirmFromDrafts: { allowUnanswered: true } },
  } } }],
} } satisfies PublicationInput;

test("逐题勘误保留来源，题面修订与教师答案修正共同升版，按当前授权恢复", t => {
  const path = scenarioDatabase(t);
  const checked: ChoiceSnapshotReviewerScope[] = [];
  let access = true;
  let external = false;
  const runtime = openLearningRuntime({ databasePath: path,
    choiceEvaluators: [{ ...evaluator, evaluate: ({ choice, acceptedChoice }) => choice === acceptedChoice }],
    authorizeChoiceSnapshotRevision: scope => access && scope.reviewerId === teacher.id && scope.studentId === student.id,
    hasChoiceSnapshotEvidence: scope => { checked.push(scope); return external; },
    authorizeChoiceDraftAmendment: () => true,
    authorizeConfirmationRecovery: () => true,
  });
  try {
    runtime.publish(publication);
    runtime.publish({ ...publication, practice: { ...publication.practice, version: 2,
      questions: publication.practice.questions.map(question => ({ ...question, version: 2 })),
    } });
    const { activityId, stepAttemptId } = runtime.prepare(student, opening);
    const scope = { protocolVersion: 1, stepAttemptId, slotId: "answers", questionId: firstId, questionVersion: 1 } as const;
    const correction: ChoiceSnapshotRevisionInput = { ...scope, operationId: "amend", baseRevision: 0,
      prompt: "勘误后的题面", options: { "0": "错误项", "1": "正确项" }, acceptedChoice: "1", reason: "勘误公开题面与私钥",
    };
    const revise = (input: ChoiceSnapshotRevisionInput) => runtime.reviseChoiceSnapshot(teacher, activityId, input);
    const denied = (error: unknown) => error instanceof LearningError && error.status === 403 && !("current" in error);
    assert.throws(() => runtime.reviseChoiceSnapshot({ ...teacher, id: "different" }, activityId, correction), denied);
    assert.throws(() => Reflect.apply(runtime.reviseChoiceSnapshot, runtime, [student, activityId, correction]), denied);
    assert.throws(() => runtime.reviseChoiceSnapshot(teacher, "44013db3-a699-4c33-ba0f-9cb8e0c239dd", correction), denied);
    const withoutSnapshotPermission = openLearningRuntime({ databasePath: path, authorizeChoiceDraftAmendment: () => true });
    try {
      assert.throws(() => withoutSnapshotPermission.reviseChoiceSnapshot(teacher, activityId, correction), denied);
    } finally {
      withoutSnapshotPermission.close();
    }
    assert.throws(() => revise({ ...correction, slotId: "different" }), { code: "INVALID_SLOT" });
    assert.throws(() => revise({ ...correction, acceptedChoice: "unknown" }), { code: "INVALID_CHOICE" });
    external = true;
    assert.throws(() => revise(correction), { code: "RESPONSE_EVIDENCE_EXISTS" });
    external = false;
    assert.throws(() => revise({ ...correction, baseRevision: 1 }), error =>
      error instanceof ChoiceSnapshotRevisionConflict && error.current.revision === 0 && !("choice" in error.current));
    const fixed = revise(correction);
    assert.deepEqual(fixed, { slotId: scope.slotId, questionId: firstId, previousQuestionVersion: 1, questionVersion: 2, revision: 1 });
    assert.deepEqual(checked.at(-1), { reviewerId: teacher.id, studentId: student.id, activityId, stepAttemptId, slotId: scope.slotId,
      questionId: firstId, questionVersion: 1, baseRevision: 0, operationId: "amend" });
    assert.equal(runtime.readChoiceDraftActivity(student, activityId), undefined);
    const view = runtime.read(student, activityId);
    assert.doesNotMatch(JSON.stringify(view), /acceptedChoice|scoringKey|勘误公开题面与私钥/);
    assert.equal("choiceDrafts" in view, false);
    assert.throws(() => runtime.replacePreparedActivityVersion(student, activityId, {
      protocolVersion: 1, stepAttemptId, operationId: "replace", expectedPracticeVersion: 1, practiceVersion: 2,
    }), { code: "ACTIVITY_ALREADY_STARTED" });
    const publishedV2 = runtime.start(student, { ...opening, operationId: "original-v2", practiceVersion: 2 });
    const v2 = runtime.read(student, publishedV2.activityId);
    assert.ok("formatVersion" in v2);
    assert.deepEqual(Object.values(v2.inputs).flatMap(input => input.from === "questions" ? input.questions : []).map(q => q.prompt),
      questions.map(q => q.prompt));
    assert.equal("choiceSnapshotRevisions" in v2, false);
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, { ...scope, questionVersion: 2, choice: "1" }), error =>
      error instanceof ChoiceDraftConflict && error.current.revision === 1 && error.current.choice === null);

    const revisedScope = { ...scope, questionVersion: 2 };
    const empty = runtime.readChoiceDraftForAmendment(teacher, activityId, revisedScope);
    assert.deepEqual([empty.revision, empty.choice, empty.changeCount], [1, null, 0]);
    const teacherAnswer = { ...revisedScope, choice: "1", baseRevision: 1, operationId: "answer", reason: "修正录入" };
    const answered = runtime.amendChoiceDraft(teacher, activityId, teacherAnswer);
    assert.deepEqual([answered.revision, answered.changeCount], [2, 0]);
    assert.deepEqual(runtime.amendChoiceDraft(teacher, activityId, teacherAnswer), answered);
    assert.throws(() => revise({ ...correction, questionVersion: 2, operationId: "has-answer", baseRevision: 2 }),
      { code: "RESPONSE_EVIDENCE_EXISTS" });
    assert.equal(runtime.readChoiceDraftActivity(student, activityId), undefined);

    const proof = { protocolVersion: 1, stepAttemptId, slotId: scope.slotId, operationId: "confirm", questions: [
      { questionId: firstId, questionVersion: 2, revision: 2, original: { state: "uncollected" } },
      { questionId: secondId, questionVersion: 1, revision: 0, original: { state: "uncollected" } },
    ] } as const;
    const receipt = runtime.confirmChoices(student, activityId, { ...proof, questions: [...proof.questions] });
    assert.deepEqual(runtime.confirmChoices(student, activityId, { ...proof, questions: [...proof.questions] }), receipt);
    const confirmed = runtime.recoverChoiceConfirmation(student, activityId, {
      protocolVersion: 1, stepAttemptId, operationId: "confirm",
    });
    assert.deepEqual(confirmed?.choiceDraftChangeCounts, [{ questionId: firstId, changeCount: 0 }, { questionId: secondId, changeCount: 0 }]);
    assert.equal(confirmed?.evaluation?.correctCount, 1);
    assert.equal(JSON.stringify(runtime.read(student, activityId)).includes("choiceDraftChangeCounts"), false);
    external = true;
    const checkedBeforeReplay = checked.length;
    assert.deepEqual(revise(correction), fixed);
    assert.equal(checked.length, checkedBeforeReplay);
    access = false;
    assert.throws(() => revise(correction), denied);
  } finally {
    runtime.close();
  }
});

test("内核已存整步草稿和撤权也能拒绝新勘误", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path,
    choiceEvaluators: [{ ...evaluator, evaluate: () => false }],
    authorizeChoiceSnapshotRevision: () => true,
    hasChoiceSnapshotEvidence: () => false,
  });
  try {
    runtime.publish(publication);
    using database = new DatabaseSync(path);
    const { activityId, stepAttemptId } = startActivity(database, student.id, opening, () => new Date(), teacher.id);
    const scope = { protocolVersion: 1, stepAttemptId, slotId: "answers" } as const;
    saveDraft(database, student.id, activityId, { ...scope, choices: { [firstId]: "0" }, references: {} });
    const input = { ...scope, questionId: firstId, questionVersion: 1, operationId: "change", baseRevision: 0,
      prompt: "New question", options: { "1": "Correct" }, acceptedChoice: "1", reason: "Clarification",
    };
    const revise = (command: ChoiceSnapshotRevisionInput) => runtime.reviseChoiceSnapshot(teacher, activityId, command);
    assert.throws(() => revise(input), { code: "RESPONSE_EVIDENCE_EXISTS" });
    const allowed = { ...input, questionId: secondId };
    assert.equal(revise(allowed).revision, 1);
    assert.deepEqual(manageReading(database, teacher.id, activityId, "revokeReviewer"), { reviewerActive: false });
    assert.throws(() => revise(allowed), { status: 403, code: "FORBIDDEN" });
  } finally {
    runtime.close();
  }
});
