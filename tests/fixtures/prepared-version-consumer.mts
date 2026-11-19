import { strict as assert } from "node:assert";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { ChoiceConfirmationInput, ChoiceDraftInput, PublicationInput } from "learning-kernel";

const [, , host, phase, outcome] = process.argv;
assert.ok(host);
const owner = { role: "student", id: host + "-prepared-owner" } as const;
const other = { role: "student", id: host + "-other" } as const;
const practiceId = "prepared-lesson";
const opening = { protocolVersion: 1, operationId: "opened", practiceId, practiceVersion: 1 } as const;
const questions = [
  { id: "first", version: 1, prompt: "2 + 3 等于多少？", options: { "0": "4", "1": "5" } },
  { id: "second", version: 1, prompt: "2 × 4 等于多少？", options: { "0": "6", "1": "8" } },
];

function publication(version: number): PublicationInput {
  return { practice: {
    id: practiceId, version, formatVersion: 1, title: "算术练习 " + version,
    goals: { arithmetic: "逐题判断" }, questions: version === 1 ? questions : questions.toReversed(),
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
}

function runRace(runtime: ReturnType<typeof openLearningRuntime>, phase: string, outcome: string | undefined) {
  const opened = runtime.prepare(owner, { ...opening, operationId: "race-open" });
  const change = { protocolVersion: 1, operationId: "racing-change", stepAttemptId: opened.stepAttemptId, expectedPracticeVersion: 1,
    practiceVersion: 2 } as const;
  const draft: ChoiceDraftInput = { protocolVersion: 1, slotId: "answers", questionId: "first", questionVersion: 1, choice: "1",
    stepAttemptId: opened.stepAttemptId, operationId: "racing-draft", baseRevision: 0 };
  if (phase === "race-prepare") {
    assert.equal(runtime.readChoiceDraftActivity(owner, opened.activityId), undefined);
  } else if (phase === "race-change") {
    try {
      assert.equal(runtime.replacePreparedActivityVersion(owner, opened.activityId, change).practiceVersion, 2);
      console.log("changed");
    } catch (error) {
      assert.ok(error instanceof LearningError && error.code === "ACTIVITY_ALREADY_STARTED");
      console.log("kept");
    }
  } else if (phase === "race-save") {
    try {
      assert.equal(runtime.saveCurrentChoiceDraft(owner, opened.activityId, draft).revision, 1);
      console.log("saved");
    } catch (error) {
      assert.ok(error instanceof LearningError && error.code === "FORBIDDEN");
      console.log("stale");
    }
  } else {
    assert.equal(phase, "race-recover");
    const view = runtime.read(owner, opened.activityId);
    assert.ok("formatVersion" in view);
    if (outcome === "changed") {
      assert.equal(view.practiceVersion, 2);
      assert.notEqual(view.stepAttemptId, opened.stepAttemptId);
      assert.deepEqual(runtime.replacePreparedActivityVersion(owner, opened.activityId, change), {
        ...opened, practiceVersion: 2, stepAttemptId: view.stepAttemptId,
      });
      assert.equal("choiceDrafts" in view, false);
      assert.equal(runtime.readChoiceDraftActivity(owner, opened.activityId), undefined);
    } else {
      assert.equal(outcome, "kept");
      assert.equal(view.practiceVersion, 1);
      assert.equal(view.stepAttemptId, opened.stepAttemptId);
      assert.ok("choiceDrafts" in view);
      assert.deepEqual(view.choiceDrafts.map(item => [item.choice, item.revision]), [["1", 1]]);
      assert.throws(() => runtime.replacePreparedActivityVersion(owner, opened.activityId, change), { code: "ACTIVITY_ALREADY_STARTED" });
    }
  }
}

const runtime = openLearningRuntime({ databasePath: "prepared.sqlite" });
try {
  if (phase?.startsWith("race-")) {
    runRace(runtime, phase, outcome);
  } else {
    if (phase === "open") {
      runtime.publish(publication(1));
      runtime.publish(publication(2));
    }
    const opened = runtime.prepare(owner, opening);
    const change = { protocolVersion: 1, operationId: "replace-v1", stepAttemptId: opened.stepAttemptId, expectedPracticeVersion: 1,
      practiceVersion: 2 } as const;
    const replace = () => runtime.replacePreparedActivityVersion(owner, opened.activityId, change);
    if (phase === "open") {
      const regular = runtime.start(owner, { ...opening, operationId: "regular" });
      assert.throws(() => runtime.prepare(owner, { ...opening, operationId: "regular" }), { code: "OPERATION_CONFLICT" });
      assert.throws(() => runtime.replacePreparedActivityVersion(owner, regular.activityId, { ...change, stepAttemptId: regular.stepAttemptId }),
        { code: "ACTIVITY_NOT_PREPARED" });
      assert.equal(runtime.read(owner, regular.activityId).title, "算术练习 1");
      assert.throws(() => runtime.replacePreparedActivityVersion(other, opened.activityId, change), { status: 403, code: "FORBIDDEN" });
      assert.deepEqual(runtime.readChoiceDraftActivity(owner, opened.activityId), undefined);
    } else {
      assert.equal(phase, "recover");
    }

    const changed = replace();
    assert.deepEqual(changed, { ...opened, stepAttemptId: changed.stepAttemptId, practiceVersion: 2 });
    assert.notEqual(changed.stepAttemptId, opened.stepAttemptId);
    assert.deepEqual(replace(), changed);
    assert.deepEqual(runtime.start(owner, opening), opened);
    assert.throws(() => runtime.start(owner, { ...opening, practiceVersion: 2 }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => runtime.replacePreparedActivityVersion(owner, opened.activityId, { ...change, practiceVersion: 3 }),
      { code: "OPERATION_CONFLICT" });
    assert.throws(() => runtime.read(other, opened.activityId), { code: "FORBIDDEN" });
    const view = runtime.read(owner, opened.activityId);
    assert.ok("formatVersion" in view);
    assert.equal(view.title, "算术练习 2");
    assert.equal(view.stepAttemptId, changed.stepAttemptId);
    assert.equal(view.practiceVersion, 2);
    assert.deepEqual(view.inputs.items, { from: "questions", questions: questions.toReversed() });

    const oldDraft: ChoiceDraftInput = { protocolVersion: 1, slotId: "answers", questionId: "first", questionVersion: 1, choice: "1",
      stepAttemptId: opened.stepAttemptId, operationId: "write", baseRevision: 0 };
    const oldConfirmation: ChoiceConfirmationInput = { protocolVersion: 1, operationId: "final", slotId: "answers",
      stepAttemptId: opened.stepAttemptId, questions: questions.map(question => ({
        questionId: question.id, questionVersion: question.version, revision: 0, original: { state: "uncollected" },
      })) };
    assert.throws(() => runtime.saveCurrentChoiceDraft(owner, opened.activityId, oldDraft), { code: "FORBIDDEN" });
    assert.throws(() => runtime.saveChoiceDraft(owner, opened.activityId, oldDraft), { code: "FORBIDDEN" });
    assert.throws(() => runtime.confirmChoices(owner, opened.activityId, oldConfirmation), { code: "FORBIDDEN" });
    assert.equal(runtime.readChoiceDraftActivity(owner, opened.activityId), undefined);
    if (phase === "recover") {
      assert.equal(runtime.saveCurrentChoiceDraft(owner, opened.activityId, { ...oldDraft, stepAttemptId: changed.stepAttemptId }).revision, 1);
      assert.throws(() => runtime.replacePreparedActivityVersion(owner, opened.activityId, { protocolVersion: 1,
        operationId: "switch-after-learning", expectedPracticeVersion: 2, practiceVersion: 1, stepAttemptId: changed.stepAttemptId,
      }), { code: "ACTIVITY_ALREADY_STARTED" });
      assert.deepEqual(replace(), changed);
    }
  }
} finally {
  runtime.close();
}
