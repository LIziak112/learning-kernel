import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput } from "../src/server.ts";
import { choiceEvaluator } from "./fixtures/evaluators.ts";
import { frozenChoicePublication } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "learner" } as const;
const practiceId = "fixed-reading-pair";
const protocolVersion = 1;
const evaluator = { id: "frozen-choice-evaluator", version: 1 };
const first = { id: "first-reading", version: 1, source: "第一来源", title: "第一份材料",
  paragraphs: [{ id: "opening", text: "第一份材料的固定正文。" }] };
const second = { id: "second-reading", version: 1, source: "第二来源", title: "第二份材料",
  paragraphs: [{ id: "opening", text: "第二份材料第一版的固定正文。" }] };
const secondRevision = { ...second, version: 2, paragraphs: [{ id: "opening", text: "第二份材料第二版的固定正文。" }] };

function publishedPair(secondMaterial = second, version = 1) {
  const base = frozenChoicePublication.practice;
  const step = base.steps[0];
  const scoringKey = { ...frozenChoicePublication.scoringKey, version };
  return {
    materials: [first, secondMaterial],
    scoringKey,
    practice: {
      ...base, id: practiceId, version,
      questions: base.questions.map(question => ({ ...question, version: 1 })),
      steps: [{ ...step, inputs: {
        ...step.inputs,
        first: { from: "material", positionId: "left-position", material: { id: first.id, version: first.version } },
        second: { from: "material", positionId: "right-position", material: { id: secondMaterial.id, version: secondMaterial.version } },
      }, submit: { ...step.submit, slots: { answers: {
        ...step.submit.slots.answers, confirmFromDrafts: { allowUnanswered: false },
      } } } }],
      grading: { assessment: { ...base.grading.assessment, evaluator, keyRef: { id: scoringKey.id, version } } },
    },
  } satisfies PublicationInput;
}

type Runtime = ReturnType<typeof openLearningRuntime>;
const settings = (databasePath: string) => ({
  databasePath, evaluators: [choiceEvaluator(evaluator, input => input.choice === input.acceptedChoice)],
  authorizeConfirmationRecovery: ({ studentId, operationId }: { studentId: string; operationId: string }) =>
    studentId === student.id && operationId === "confirm",
});

function request(practiceVersion = 1, operationId = "open", id = practiceId) {
  return { protocolVersion, practiceId: id, practiceVersion, operationId } as const;
}

function readingView(runtime: Runtime, activityId: string) {
  const view = runtime.read(student, activityId);
  assert.ok("formatVersion" in view);
  return view;
}

function assertPair(view: ReturnType<typeof readingView>, material = second) {
  assert.deepEqual(view.inputs.first, { from: "material", positionId: "left-position", material: first });
  assert.deepEqual(view.inputs.second, { from: "material", positionId: "right-position", material });
  assert.equal(view.material, undefined);
  assert.deepEqual(Object.keys(view.inputs).sort(), ["first", "questions", "second"]);
  assert.doesNotMatch(JSON.stringify(view), /acceptedChoices|scoringKey|acceptedChoice|未绑定的私有材料/);
}

test("仅第二份重发新版，已保存的旧卷重开保留两个材料位置、原草稿及旧评估", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(settings(databasePath));
  const publication = publishedPair();
  const [question, secondQuestion] = publication.practice.questions;
  assert.ok(question && secondQuestion);
  let saved: ReturnType<Runtime["saveCurrentChoiceDraft"]>;
  let old: ReturnType<Runtime["start"]>;
  let fresh: ReturnType<Runtime["start"]>;
  let oldView: ReturnType<typeof readingView>;
  try {
    runtime.publish(publication);
    old = runtime.start(student, request());
    const choice = publication.scoringKey.acceptedChoices[question.id];
    assert.ok(choice);
    saved = runtime.saveCurrentChoiceDraft(student, old.activityId, {
      protocolVersion, stepAttemptId: old.stepAttemptId, slotId: "answers", questionId: question.id,
      questionVersion: 1, choice, operationId: "save", baseRevision: 0,
    });
    oldView = readingView(runtime, old.activityId);
    assertPair(oldView);
    assert.ok("choiceDrafts" in oldView);
    assert.deepEqual(oldView.choiceDrafts, [saved]);
    runtime.publish(publishedPair(secondRevision, 2));
    fresh = runtime.start(student, request(2, "open-new"));
    assertPair(readingView(runtime, fresh.activityId), secondRevision);
    assert.notEqual(fresh.activityId, old.activityId);
    const privateMaterial = { ...first, id: "unrelated-material",
      paragraphs: [{ id: "opening", text: "未绑定的私有材料" }] };
    const { practice: practiceWithPair, scoringKey } = publication;
    const otherId = "separate-legacy-practice";
    const [prior] = frozenChoicePublication.practice.steps;
    runtime.publish({ scoringKey, material: privateMaterial, practice: {
      ...practiceWithPair, id: otherId, material: { id: privateMaterial.id, version: 1 },
      steps: [{ ...prior, inputs: { ...prior.inputs, another: { from: "material", positionId: "other-position" } } }],
      grading: frozenChoicePublication.practice.grading,
    } });
    assertPair(readingView(runtime, old.activityId));
  } finally {
    runtime.close();
  }
  const reopened = openLearningRuntime(settings(databasePath));
  try {
    assert.deepEqual(reopened.start(student, request()), old);
    assert.deepEqual(reopened.start(student, request(2, "open-new")), fresh);
    assert.deepEqual(readingView(reopened, old.activityId), oldView);
    assertPair(readingView(reopened, fresh.activityId), secondRevision);
    assert.throws(() => reopened.read({ ...student, id: "other" }, old.activityId), { status: 403, code: "FORBIDDEN" });
    const choice = publication.scoringKey.acceptedChoices[secondQuestion.id];
    assert.ok(choice);
    const last = reopened.saveCurrentChoiceDraft(student, old.activityId, {
      protocolVersion, stepAttemptId: old.stepAttemptId, slotId: "answers", questionId: secondQuestion.id,
      questionVersion: 1, choice, operationId: "save-second", baseRevision: 0,
    });
    const originals = { state: "uncollected" } as const;
    const key = { protocolVersion, stepAttemptId: old.stepAttemptId, operationId: "confirm" } as const;
    const receipt = reopened.confirmChoices(student, old.activityId, { ...key, slotId: "answers", questions: [saved, last].map(draft => ({
      questionId: draft.questionId, questionVersion: draft.questionVersion, revision: draft.revision, original: originals,
    })) });
    const found = reopened.recoverChoiceConfirmation(student, old.activityId, key);
    assert.deepEqual(found.receipt, receipt);
    assert.equal(found.evaluation?.correctCount, 2);
    assertPair(readingView(reopened, old.activityId));
  } finally {
    reopened.close();
  }
});

function rejectsAt(path: (string | number)[]) {
  return (error: unknown) => error instanceof ZodError &&
    error.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(path));
}

test("缺失或错误版本、重复位置、自由引用和多余定义均拒绝且练法不可启动", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(settings(databasePath));
  try {
    const valid = publishedPair();
    const [step] = valid.practice.steps;
    assert.ok(step);
    const secondInput = ["practice", "steps", 0, "inputs", "second"] as const;
    const withSecond = (input: object) => ({ ...valid, practice: { ...valid.practice, steps: [
      { ...step, inputs: { ...step.inputs, second: input } },
    ] } });
    const invalid: [unknown, (string | number)[]][] = [
      [{ ...valid, materials: [first] }, [...secondInput, "material"]],
      [{ ...valid, materials: [first, secondRevision] }, [...secondInput, "material"]],
      [withSecond({ from: "material", positionId: "right-position" }), [...secondInput, "material"]],
      [withSecond({ ...step.inputs.second, positionId: step.inputs.first.positionId }), [...secondInput, "positionId"]],
      [{ ...valid, materials: [...valid.materials, second] }, ["materials", 2]],
      [{ ...valid, materials: [...valid.materials, { ...first, id: "outside" }] }, ["materials", 2]],
      [{ ...valid, material: first }, ["materials"]],
      [{ ...valid, practice: { ...valid.practice, material: { id: first.id, version: 1 } } }, ["materials"]],
      [{ ...valid, materials: undefined, material: first, practice: { ...valid.practice, material: { id: first.id, version: 1 } } }, [...secondInput, "material"]],
      [{ ...valid, materials: undefined, practice: { ...valid.practice, steps: [{ ...step, inputs: {
        questions: step.inputs.questions, first: { from: "material", positionId: "left-position" },
      } }] } }, ["practice", "material"]],
      [withSecond({ ...step.inputs.second, material: { id: second.id } }), [...secondInput, "material", "version"]],
      [{ ...valid, practice: { ...valid.practice, steps: [{ ...step, submit: { ...step.submit, purpose: "stepEvidence" } }] } }, ["practice", "steps"]],
      [{ ...valid, practice: { ...valid.practice, steps: [{ ...step, tool: { id: "response-group", version: 1 } }] } }, ["practice", "steps"]],
      [{ ...valid, practice: { ...valid.practice, steps: [
        { ...step, afterConfirmation: "advance" },
        { ...step, id: "another-step", requires: step.id, inputs: { questions: step.inputs.questions } },
      ] } }, ["practice", "steps"]],
    ];
    for (const [publication, path] of invalid) {
      assert.throws(() => Reflect.apply(runtime.publish, runtime, [publication]), rejectsAt(path));
      assert.throws(() => runtime.start(student, request()), { status: 404, code: "PRACTICE_NOT_FOUND" });
    }
    using database = new DatabaseSync(databasePath, { readOnly: true });
    for (const table of ["materials", "practices", "scoring_keys", "activities"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    runtime.publish(valid);
    assertPair(readingView(runtime, runtime.start(student, request()).activityId));
  } finally {
    runtime.close();
  }
});

test("同一材料可在独立位置使用，旧单材料和无材料仍有原公开形状", t => {
  const runtime = openLearningRuntime(settings(scenarioDatabase(t)));
  try {
    const pair = publishedPair();
    const [step] = pair.practice.steps;
    assert.ok(step);
    runtime.publish({ ...pair, materials: [first], practice: { ...pair.practice, steps: [{ ...step, inputs: {
      ...step.inputs, second: { ...step.inputs.second, material: step.inputs.first.material },
    } }] } });
    assertPair(readingView(runtime, runtime.start(student, request()).activityId), first);
    const { material: firstRef, ...firstPosition } = step.inputs.first;
    const secondPosition = { from: step.inputs.second.from, positionId: step.inputs.second.positionId };
    const legacyId = "legacy-one-material";
    runtime.publish({ material: first, scoringKey: pair.scoringKey, practice: {
      ...pair.practice, id: legacyId, material: firstRef, steps: [{ ...step, inputs: {
        ...step.inputs, first: firstPosition, second: secondPosition,
      } }],
    } });
    const legacy = readingView(runtime, runtime.start(student, request(1, "legacy-open", legacyId)).activityId);
    assert.deepEqual(legacy.material, first);
    assert.deepEqual(legacy.inputs.first, firstPosition);
    assert.deepEqual(legacy.inputs.second, secondPosition);
    const control = frozenChoicePublication;
    const scoringKey = { ...control.scoringKey, id: "no-material-key" };
    runtime.publish({ scoringKey, practice: { ...control.practice, grading: {
      assessment: { ...control.practice.grading.assessment, keyRef: { id: scoringKey.id, version: scoringKey.version } },
    } } });
    const none = readingView(runtime, runtime.start(student, request(1, "no-material-open", control.practice.id)).activityId);
    assert.equal(none.material, undefined);
    assert.deepEqual(Object.keys(none.inputs), ["questions"]);
  } finally {
    runtime.close();
  }
});

test("不可变版本冲突回滚同次发布的先写材料和练法", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(settings(databasePath));
  try {
    const initial = publishedPair();
    runtime.publish(initial);
    const edit = publishedPair({ ...second, paragraphs: [{ id: "opening", text: "不得原地覆写的正文" }] }, 2);
    const [step] = edit.practice.steps;
    assert.ok(step);
    const newest = { ...first, version: 2 };
    const changed = edit.materials[1];
    assert.ok(changed);
    assert.throws(() => runtime.publish({ ...edit, materials: [newest, changed], practice: {
      ...edit.practice, steps: [{ ...step, inputs: {
        ...step.inputs, first: { ...step.inputs.first, material: { id: newest.id, version: newest.version } },
      } }],
    } }), /已发布.*不能更改/);
    assert.throws(() => runtime.start(student, request(2, "open-v2")), { status: 404, code: "PRACTICE_NOT_FOUND" });
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM materials").get()?.count, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM scoring_keys").get()?.count, 1);
    assertPair(readingView(runtime, runtime.start(student, request()).activityId));
  } finally {
    runtime.close();
  }
});

test("位置读取遇到缺失或不匹配的持久版本时拒绝回退到新版", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(settings(databasePath));
  try {
    runtime.publish(publishedPair());
    runtime.publish(publishedPair(secondRevision, 2));
    const earlier = runtime.start(student, request());
    const newer = runtime.start(student, request(2, "open-2"));
    using database = new DatabaseSync(databasePath);
    database.prepare("DELETE FROM materials WHERE id = ? AND version = ?").run(second.id, second.version);
    assert.throws(() => runtime.read(student, earlier.activityId), /引用的已发布材料不存在/);
    assertPair(readingView(runtime, newer.activityId), secondRevision);
    database.prepare("INSERT INTO materials (id, version, definition) VALUES (?, ?, ?)")
      .run(second.id, second.version, JSON.stringify(secondRevision));
    assert.throws(() => runtime.read(student, earlier.activityId), /与已发布版本不一致/);
    assert.throws(() => runtime.read({ ...student, id: "other" }, earlier.activityId), { status: 403, code: "FORBIDDEN" });
  } finally {
    runtime.close();
  }
});
