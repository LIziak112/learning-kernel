import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as kernel from "learning-kernel";
import type { PublicationInput } from "learning-kernel";

const alice = { role: "student", id: "alice" } as const;
const bob = { role: "student", id: "bob" } as const;
const questions = [
  { id: "first", version: 1, prompt: "2 + 3 等于多少？", options: { "0": "4", "1": "5" } },
  { id: "second", version: 1, prompt: "2 × 4 等于多少？", options: { "0": "6", "1": "8" } },
];
const publication: PublicationInput = { practice: {
  id: "backup-exercise", version: 1, formatVersion: 1, title: "整数运算", goals: { arithmetic: "逐题判断" }, questions,
  steps: [{
    id: "answer", instructions: "每题选一个选项。", tool: { id: "single-choice-group", version: 1 },
    inputs: { items: { from: "questions" } }, submit: { purpose: "finalAnswer", slots: {
      answers: { type: "oneChoicePerQuestion", source: "items", targetId: "arithmetic", confirmFromDrafts: { allowUnanswered: true } },
    } }, afterConfirmation: "finish",
  }],
  policy: {
    offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
    student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt"], onFinal: [] } },
    reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
    manager: { scope: "assigningTeacher", actions: [] },
  },
} };
const open = { protocolVersion: 1, operationId: "opening", practiceId: publication.practice.id, practiceVersion: 1 } as const;
const working = "backup-working.sqlite";
const early = "backup-early.sqlite";
const late = "backup-late.sqlite";
const initial = kernel.openLearningRuntime({ databasePath: working });
let firstBinding;
try {
  initial.publish(publication);
  const opened = initial.prepare(alice, open);
  firstBinding = { studentId: alice.id, activityId: opened.activityId, operationId: open.operationId };
} finally {
  initial.close();
}
copyFileSync(working, early);
const plan: kernel.ActivityBindingClaims = { protocolVersion: 1, bindings: [firstBinding], openingIntents: [] };
const next = kernel.openLearningRuntime({ databasePath: working });
let secondBinding;
try {
  const opened = next.start(bob, open);
  secondBinding = { studentId: bob.id, activityId: opened.activityId, operationId: open.operationId };
  next.confirmChoices(bob, opened.activityId, {
    protocolVersion: 1, operationId: "confirmed", stepAttemptId: opened.stepAttemptId, slotId: "answers",
    questions: questions.map(question => ({ questionId: question.id, questionVersion: question.version, revision: 0,
      original: { state: "uncollected" } })),
  });
  next.evaluatePending();
} finally {
  next.close();
}
copyFileSync(working, late);

const earlyRuntime = kernel.openLearningRuntime({ databasePath: early });
const lateRuntime = kernel.openLearningRuntime({ databasePath: late });
try {
  assert.deepEqual(earlyRuntime.read(alice, firstBinding.activityId), lateRuntime.read(alice, firstBinding.activityId));
  assert.equal(lateRuntime.read(bob, secondBinding.activityId).status, "completed");
  assert.throws(() => earlyRuntime.read(bob, secondBinding.activityId), { code: "FORBIDDEN" });
  assert.equal("verifyActivityBindings" in lateRuntime, false);
} finally {
  earlyRuntime.close();
  lateRuntime.close();
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = [digest(early), digest(late)];
const pending = { ...plan, openingIntents: [{ studentId: bob.id, operationId: open.operationId }] };
const complete = { ...plan, bindings: [firstBinding, secondBinding] };
const mismatch = { status: 409, code: "ACTIVITY_BINDINGS_MISMATCH" };
assert.equal(kernel.verifyActivityBindings(early, plan), undefined);
assert.throws(() => kernel.verifyActivityBindings(late, plan), mismatch);
assert.throws(() => kernel.verifyActivityBindings(early, complete), mismatch);
assert.equal(kernel.verifyActivityBindings(late, complete), undefined);
assert.equal(kernel.verifyActivityBindings(early, pending), undefined);
assert.equal(kernel.verifyActivityBindings(late, pending), undefined);
assert.throws(() => kernel.verifyActivityBindings(late, { ...plan, bindings: [firstBinding, firstBinding, secondBinding] }), mismatch);
assert.throws(() => kernel.verifyActivityBindings(late, { ...pending, openingIntents: [...pending.openingIntents, ...pending.openingIntents] }), mismatch);
assert.throws(() => kernel.verifyActivityBindings(late, { ...complete, openingIntents: pending.openingIntents }), mismatch);
assert.throws(() => kernel.verifyActivityBindings(late, { ...complete, bindings: [firstBinding, { ...secondBinding, studentId: "someone" }] }), mismatch);
assert.throws(() => kernel.verifyActivityBindings(late, { ...complete, bindings: [firstBinding, { ...secondBinding, operationId: "different" }] }), mismatch);
assert.throws(() => kernel.verifyActivityBindings(late, { ...complete, bindings: [
  { ...firstBinding, activityId: secondBinding.activityId }, secondBinding,
] }), mismatch);
assert.deepEqual([digest(early), digest(late)], before);

kernel.openLearningRuntime({ databasePath: "backup-empty.sqlite" }).close();
const empty = { ...plan, bindings: [] };
assert.equal(kernel.verifyActivityBindings("backup-empty.sqlite", empty), undefined);
assert.throws(() => kernel.verifyActivityBindings("backup-does-not-exist.sqlite", empty));
assert.equal(existsSync("backup-does-not-exist.sqlite"), false);
writeFileSync("backup-unreadable.sqlite", "not a database");
const unreadable = digest("backup-unreadable.sqlite");
assert.throws(() => kernel.verifyActivityBindings("backup-unreadable.sqlite", empty));
assert.equal(digest("backup-unreadable.sqlite"), unreadable);
