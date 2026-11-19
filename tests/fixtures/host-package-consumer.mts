import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { ChoiceDraftConflict, LearningError, openLearningRuntime } from "learning-kernel";
import type { ChoiceDraftInput, PublicationInput, StudentPrincipal } from "learning-kernel";

const [, , name, phase] = process.argv;
assert.ok(name);
const host = name;
const choiceDrafting = host === "library-club";
const owner: StudentPrincipal = { role: "student", id: `${host}-owner` };
const other: StudentPrincipal = { role: "student", id: `${host}-other` };
const opening = { protocolVersion: 1, operationId: `${host}-opening`, practiceId: host, practiceVersion: 1 } as const;
const runtime = openLearningRuntime({ databasePath: "learning.sqlite" });
assert.equal("database" in runtime, false);
assert.equal("checkpoint" in runtime, false);
assert.throws(() => import.meta.resolve("learning-kernel/src/kernel/database.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });

function publication(version: number): PublicationInput {
  const material = host === "after-school" ? {
    id: `${host}-arithmetic`, version: 1, title: "整数运算题面", source: "教师的运算练习资料",
    paragraphs: [{ id: "q1", text: "2 + 3 等于多少？" }, { id: "q2", text: "2 × 4 等于多少？" }],
  } : undefined;
  const scoringKey = { id: `${host}-key`, version: 1, acceptedChoices: choiceDrafting ? { q1: "1", q2: "2" } : { q1: "b", q2: "c" } };
  return {
    ...(material ? { material } : {}), scoringKey,
    practice: {
      id: host, version, formatVersion: 1, title: `整数运算 ${version}`,
      ...(material ? { material: { id: material.id, version: material.version } } : {}),
      goals: { arithmetic: "按题判断运算结果" },
      questions: [
        {
          id: "q1", ...(choiceDrafting ? { version } : {}), prompt: version === 1 ? "2 + 3 等于多少？" : "3 + 2 等于多少？",
          options: choiceDrafting ? { "0": "4", "1": "5", "2": "6" } : { a: "4", b: "5", c: "6" },
        },
        {
          id: "q2", ...(choiceDrafting ? { version } : {}), prompt: "2 × 4 等于多少？",
          options: choiceDrafting ? { "0": "4", "1": "6", "2": "8" } : { a: "4", b: "6", c: "8" },
        },
      ],
      steps: [{
        id: "answers", instructions: "每题选一个选项。", tool: { id: "single-choice-group", version: 1 },
        inputs: { items: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { choices: { type: "oneChoicePerQuestion", source: "items", targetId: "arithmetic" } } },
        afterConfirmation: "finish",
      }],
      grading: {
        assessment: {
          from: { stepId: "answers", slotId: "choices" }, evaluator: { id: "choice-key", version: 1 },
          keyRef: { id: scoringKey.id, version: 1 }, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
        },
      },
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownChoices"], onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: ["gradingBasis"], actions: [] },
        manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  };
}

function expectError(action: () => unknown, status: number, code: string) {
  assert.throws(action, error => error instanceof LearningError && error.status === status && error.code === code);
}

function firstChoice(stepAttemptId: string): ChoiceDraftInput {
  return { protocolVersion: 1, operationId: "draft-1", stepAttemptId, slotId: "choices", questionId: "q1", questionVersion: 1, baseRevision: 0, choice: "0" };
}

function readDrafts(activityId: string) {
  const activity = runtime.read(owner, activityId);
  assert.ok("choiceDrafts" in activity);
  return activity.choiceDrafts;
}

try {
  if (phase === "start") {
    runtime.publish(publication(1));
    const receipt = runtime.start(owner, opening);
    assert.deepEqual(runtime.start(owner, opening), receipt);
    const first = firstChoice(receipt.stepAttemptId);
    if (choiceDrafting) {
      const saved = runtime.saveChoiceDraft(owner, receipt.activityId, first);
      assert.deepEqual(saved, { slotId: "choices", questionId: "q1", questionVersion: 1, revision: 1, changeCount: 1, choice: "0" });
      const edited = runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, operationId: "draft-2", baseRevision: 1, choice: "1" });
      assert.equal(edited.revision, 2);
      assert.deepEqual(runtime.saveChoiceDraft(owner, receipt.activityId, first), saved);
      assert.deepEqual(runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, operationId: "convergence", choice: "1" }), edited);
      assert.throws(() => runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, operationId: "stale", choice: "2" }), error => {
        assert.ok(error instanceof ChoiceDraftConflict);
        assert.deepEqual(error.current, { revision: 2, choice: "1" });
        return true;
      });
    } else {
      expectError(() => runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, choice: "a" }), 409, "QUESTION_REVISION_STALE");
    }
    writeFileSync("receipt.json", JSON.stringify(receipt));
  } else if (phase === "recover") {
    runtime.publish(publication(2));
    const original: unknown = JSON.parse(readFileSync("receipt.json", "utf8"));
    const receipt = runtime.start(owner, opening);
    assert.deepEqual(receipt, original);
    expectError(() => runtime.start(owner, { ...opening, practiceVersion: 2 }), 409, "OPERATION_CONFLICT");
    expectError(() => runtime.start(owner, { ...opening, operationId: "absent", practiceVersion: 3 }), 404, "PRACTICE_NOT_FOUND");

    const activity = runtime.read(owner, receipt.activityId);
    assert.equal(activity.activityId, receipt.activityId);
    assert.equal(activity.stepAttemptId, receipt.stepAttemptId);
    assert.equal(activity.startedAt, receipt.startedAt);
    assert.equal(activity.title, "整数运算 1");
    assert.equal(activity.status, "active");
    assert.equal(activity.step.tool.id, "single-choice-group");
    assert.ok("formatVersion" in activity);
    assert.deepEqual(Object.keys(activity.inputs), ["items"]);
    const items = activity.inputs.items;
    assert.ok(items?.from === "questions");
    const frozen = publication(1).practice;
    assert.ok("questions" in frozen);
    assert.deepEqual(items.questions, frozen.questions);
    assert.doesNotMatch(JSON.stringify(activity), /scoringKey|acceptedChoices|gradingBasis|教师的运算练习资料|reviewer/);

    const oldEdition = runtime.start(owner, { ...opening, operationId: "fresh-old-edition" });
    assert.notEqual(oldEdition.activityId, receipt.activityId);
    assert.equal(runtime.read(owner, oldEdition.activityId).title, "整数运算 1");
    const newEdition = runtime.start(other, { ...opening, practiceVersion: 2 });
    assert.notEqual(newEdition.activityId, receipt.activityId);
    assert.equal(runtime.read(other, newEdition.activityId).title, "整数运算 2");
    expectError(() => runtime.read(other, receipt.activityId), 403, "FORBIDDEN");
    expectError(() => runtime.read(owner, newEdition.activityId), 403, "FORBIDDEN");
    if (choiceDrafting) {
      const first = firstChoice(receipt.stepAttemptId);
      assert.deepEqual(readDrafts(receipt.activityId), [
        { slotId: "choices", questionId: "q1", questionVersion: 1, revision: 2, changeCount: 2, choice: "1" },
      ]);
      assert.equal(runtime.saveChoiceDraft(owner, receipt.activityId, first).revision, 1);
      expectError(() => runtime.saveChoiceDraft(other, receipt.activityId, first), 403, "FORBIDDEN");
      expectError(() => runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, operationId: "future", questionVersion: 2 }),
        409, "QUESTION_REVISION_STALE");
    }
  } else {
    const receipt = runtime.start(owner, opening);
    const first = { ...firstChoice(receipt.stepAttemptId), operationId: "parallel" };
    if (phase === "parallel-q1") {
      assert.equal(runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, baseRevision: 2, choice: "2" }).revision, 3);
    } else if (phase === "parallel-q2") {
      assert.equal(runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, questionId: "q2" }).revision, 1);
    } else {
      assert.equal(phase, "parallel-recover");
      assert.equal(runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, operationId: "convergence", choice: "1" }).revision, 2);
      assert.throws(() => runtime.saveChoiceDraft(owner, receipt.activityId, { ...first, operationId: "draft-1", choice: "1" }), error => {
        assert.ok(error instanceof ChoiceDraftConflict);
        assert.equal(error.code, "OPERATION_CONFLICT");
        assert.deepEqual(error.current, { revision: 3, choice: "2" });
        return true;
      });
      assert.deepEqual(readDrafts(receipt.activityId).map(({ questionId, revision, choice }) => [questionId, revision, choice]),
        [["q1", 3, "2"], ["q2", 1, "0"]]);
    }
  }
} finally {
  runtime.close();
}
