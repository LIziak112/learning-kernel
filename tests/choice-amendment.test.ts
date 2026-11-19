import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { startActivity } from "../src/kernel/activity.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { ChoiceDraftConflict, LearningError, openLearningRuntime } from "../src/server.ts";
import type { AuthorizeChoiceDraftAmendment, ChoiceDraftAmendmentInput, PublicationInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "author" } as const;
const teacher = { role: "reviewer", id: "assigned" } as const;
const open = { protocolVersion: 1, operationId: "begin", practiceId, practiceVersion: 1 } as const;
const { practice } = frozenChoicePublication;
const publication = { practice: { ...practice, grading: {},
  questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })),
} } satisfies PublicationInput;
const [first, second] = questions;
assert.ok(first && second);
const firstId = first.id;
const secondId = second.id;
const originalTime = "2026-11-18T00:00:01.000Z";
const studentTime = "2026-11-18T00:00:02.000Z";

function withoutCurrent(code: string, status = 409) {
  return (error: unknown) => error instanceof LearningError && error.status === status && error.code === code && !("current" in error);
}

test("授权教师修正冻结题，独立计量学生操作，失败一起回滚", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(originalTime) });
  const path = scenarioDatabase(t);
  const checked: Parameters<AuthorizeChoiceDraftAmendment>[0][] = [];
  let allow = true;
  const runtime = openLearningRuntime({ databasePath: path, authorizeChoiceDraftAmendment: scope => {
    checked.push(scope);
    return allow && scope.reviewerId === teacher.id && scope.studentId === student.id;
  } });
  try {
    runtime.publish(publication);
    using database = new DatabaseSync(path);
    const { activityId, stepAttemptId } = startActivity(database, student.id, open, () => new Date(), teacher.id);
    const scope = { protocolVersion: 1, stepAttemptId, slotId: "answers", questionId: firstId, questionVersion: 1 } as const;
    const { protocolVersion, ...frozenScope } = scope;
    const command: ChoiceDraftAmendmentInput = { ...scope, choice: "1", operationId: "teacher-first", baseRevision: 0, reason: "修正记录" };
    const read = () => runtime.readChoiceDraftForAmendment(teacher, activityId, scope);
    const amend = (input: ChoiceDraftAmendmentInput) => runtime.amendChoiceDraft(teacher, activityId, input);
    const forbidden = withoutCurrent("FORBIDDEN", 403);
    assert.doesNotThrow(read);
    assert.deepEqual(read(), { slotId: "answers", questionId: firstId, questionVersion: 1, choice: null, revision: 0, changeCount: 0 });
    assert.deepEqual(checked[0], { ...frozenScope, action: "read", activityId, reviewerId: teacher.id, studentId: student.id });
    assert.throws(() => runtime.readChoiceDraftForAmendment({ ...teacher, id: "another-teacher" }, activityId, scope), forbidden);
    assert.throws(() => Reflect.apply(runtime.amendChoiceDraft, runtime, [student, activityId, command]), forbidden);
    const nonexistent = "44013db3-a699-4c33-ba0f-9cb8e0c239dd";
    assert.throws(() => runtime.readChoiceDraftForAmendment(teacher, nonexistent, scope), forbidden);
    assert.throws(() => amend({ ...command, stepAttemptId: nonexistent }), forbidden);
    assert.throws(() => amend({ ...command, reason: " " }), ZodError);
    assert.throws(() => amend({ ...command, choice: "invalid" }), { status: 422, code: "INVALID_CHOICE" });
    assert.throws(() => amend({ ...command, questionVersion: 2 }), withoutCurrent("QUESTION_REVISION_STALE"));
    const denied = openLearningRuntime({ databasePath: path });
    try {
      assert.throws(() => denied.amendChoiceDraft(teacher, activityId, command), forbidden);
    } finally {
      denied.close();
    }

    assert.doesNotThrow(() => amend(command));
    const first = amend(command);
    assert.deepEqual(checked.at(-1), { ...frozenScope, action: "amend", activityId, reviewerId: teacher.id, studentId: student.id });
    assert.deepEqual(read(), first);
    assert.deepEqual([first.choice, first.revision, first.changeCount], ["1", 1, 0]);
    assert.deepEqual(amend({ ...command, reason: "  修正记录  " }), first);
    for (const mismatch of [{ questionVersion: 2 }, { choice: "0" }, { baseRevision: 1 }, { reason: "不同理由" }]) {
      assert.throws(() => amend({ ...command, ...mismatch }), withoutCurrent("OPERATION_CONFLICT"));
    }
    assert.throws(() => amend({ ...command, operationId: "stale" }), error =>
      error instanceof ChoiceDraftConflict && error.current.revision === 1 && error.current.choice === "1");
    const sameChoice = amend({ ...command, baseRevision: 1, operationId: "teacher-same" });
    assert.deepEqual([sameChoice.revision, sameChoice.changeCount], [2, 0]);
    const blind = { ...scope, choice: "1" };
    assert.throws(() => runtime.saveChoiceDraft(student, activityId, blind), { code: "ANSWER_REVISION_CONFLICT" });
    assert.equal(runtime.readChoiceDraftActivity(student, activityId), undefined);
    assert.deepEqual(runtime.saveChoiceDraft(student, activityId, { ...blind, operationId: "student-same", baseRevision: 2 }), sameChoice);
    assert.equal(runtime.readChoiceDraftActivity(student, activityId), undefined);

    t.mock.timers.setTime(Date.parse(studentTime));
    const studentWrite = { ...blind, choice: "0", operationId: "student-change", baseRevision: 2 };
    const saved = runtime.saveCurrentChoiceDraft(student, activityId, studentWrite);
    assert.deepEqual([saved.revision, saved.changeCount], [3, 1]);
    const times = { firstChangedAt: studentTime, lastChangedAt: studentTime };
    assert.deepEqual(runtime.readChoiceDraftActivity(student, activityId), times);
    t.mock.timers.setTime(Date.parse(studentTime) + 1_000);
    database.exec("CREATE TRIGGER stop_amendment BEFORE INSERT ON choice_draft_amendments BEGIN SELECT RAISE(ABORT, 'amendment aborted'); END");
    assert.throws(() => amend({ ...command, operationId: "aborted", baseRevision: 3 }), /amendment aborted/);
    assert.deepEqual(read(), saved);
    assert.deepEqual(runtime.saveCurrentChoiceDraft(student, activityId, studentWrite, "replayLatestOnly"), saved);
    assert.deepEqual(runtime.readChoiceDraftActivity(student, activityId), times);
    database.exec("DROP TRIGGER stop_amendment");

    const second = runtime.readChoiceDraftForAmendment(teacher, activityId, { ...scope, questionId: secondId });
    assert.deepEqual([second.choice, second.revision, second.changeCount], [null, 0, 0]);
    const view = runtime.read(student, activityId);
    assert.ok("choiceDrafts" in view);
    assert.deepEqual(view.choiceDrafts, [saved]);
    const record = database.prepare("SELECT reviewer_id, operation_id, reason, amended_at FROM choice_draft_amendments ORDER BY revision");
    assert.deepEqual(record.all().map(row => Object.values(row)), [
      [teacher.id, "teacher-first", "修正记录", originalTime],
      [teacher.id, "teacher-same", "修正记录", originalTime],
    ]);

    const amendmentAfterStudent = amend({ ...command, operationId: "teacher-after-student", baseRevision: 3 });
    assert.deepEqual([amendmentAfterStudent.choice, amendmentAfterStudent.revision, amendmentAfterStudent.changeCount], ["1", 4, 1]);
    assert.deepEqual(runtime.saveChoiceDraft(student, activityId, studentWrite), saved);
    assert.throws(() => runtime.saveCurrentChoiceDraft(student, activityId, { ...studentWrite, choice: "1" }, "replayLatestOnly"),
      { code: "DRAFT_REPLAY_REQUIRED" });
    assert.deepEqual(runtime.readChoiceDraftActivity(student, activityId), times);

    const studentRevoked = startActivity(database, student.id, { ...open, operationId: "revoked" }, () => new Date(), teacher.id);
    const beforeRevocation = { ...command, stepAttemptId: studentRevoked.stepAttemptId };
    runtime.amendChoiceDraft(teacher, studentRevoked.activityId, beforeRevocation);
    assert.deepEqual(manageReading(database, teacher.id, studentRevoked.activityId, "revokeStudent"), { studentActive: false });
    assert.throws(() => runtime.readChoiceDraftForAmendment(teacher, studentRevoked.activityId, {
      ...scope, stepAttemptId: studentRevoked.stepAttemptId,
    }), forbidden);
    assert.throws(() => runtime.amendChoiceDraft(teacher, studentRevoked.activityId, beforeRevocation), forbidden);

    allow = false;
    assert.throws(read, forbidden);
    assert.throws(() => amend(command), forbidden);
    allow = true;
    assert.deepEqual(amend(command), first);
    assert.deepEqual(manageReading(database, teacher.id, activityId, "revokeReviewer"), { reviewerActive: false });
    assert.throws(read, forbidden);
    assert.throws(() => amend(command), forbidden);
  } finally {
    runtime.close();
  }
});
