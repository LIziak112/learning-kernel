import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { LearningError, openLearningRuntime } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";
import { frozenChoicePublication as candidate, practiceId, questions } from "./fixtures/frozen-choice.ts";

const student = { role: "student", id: "reader" } as const;
const open = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;

function recordedCounts(path: string) {
  using database = new DatabaseSync(path, { readOnly: true });
  const tables = ["materials", "practices", "scoring_keys", "activities", "step_attempts", "works", "submissions"];
  return tables.map(table => database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count);
}

test("通过公开入口发布无材料的两道单选题，重开原库后仍读取原题面", t => {
  const path = scenarioDatabase(t);
  let receipt: ReturnType<ReturnType<typeof openLearningRuntime>["start"]>;
  {
    const runtime = openLearningRuntime({ databasePath: path });
    try {
      assert.doesNotThrow(() => runtime.publish(candidate));
      runtime.publish(candidate);
      receipt = runtime.start(student, open);
      assert.deepEqual(runtime.start(student, open), receipt);
      assert.deepEqual(recordedCounts(path), [0, 1, 1, 1, 1, 0, 0]);
    } finally {
      runtime.close();
    }
  }
  const reopened = openLearningRuntime({ databasePath: path });
  try {
    assert.deepEqual(reopened.start(student, open), receipt);
    const view = reopened.read(student, receipt.activityId);
    assert.ok("formatVersion" in view);
    assert.equal(view.activityId, receipt.activityId);
    assert.equal(view.stepAttemptId, receipt.stepAttemptId);
    assert.equal(view.status, "active");
    assert.equal(view.step.id, "answer");
    assert.deepEqual(view.inputs, { questions: { from: "questions", questions } });
    assert.equal(view.material, undefined);
    assert.doesNotMatch(JSON.stringify(view), /"material"|"scoringKey"|"acceptedChoices"|"keyRef"|"solutionMd"/);
    assert.throws(() => reopened.read({ ...student, id: "other" }, receipt.activityId),
      error => error instanceof LearningError && error.status === 403 && error.code === "FORBIDDEN");
  } finally {
    reopened.close();
  }
});

test("材料依赖和发布定义必须成对且版本一致，失败不留下学习事实", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    const { material, ...readingWithoutMaterial } = reading.practice;
    assert.throws(() => Reflect.apply(runtime.publish, runtime, [{ practice: readingWithoutMaterial, scoringKey: reading.scoringKey }]),
      error => error instanceof ZodError && error.issues.some(issue => issue.path.join(".") === "practice.material"));
    const [step] = candidate.practice.steps;
    const inputs = { ...step.inputs, passage: { from: "material" as const, positionId: "passage" } };
    assert.throws(() => runtime.publish({ ...candidate,
      practice: { ...candidate.practice, steps: [{ ...step, inputs }] },
    }), error => error instanceof ZodError && error.issues.some(issue => issue.path.join(".") === "practice.material"));
    assert.throws(() => runtime.publish({ ...candidate, material: reading.material }), /引用的材料版本与发布材料不一致/);
    assert.throws(() => runtime.publish({ ...candidate, practice: { ...candidate.practice, material } }), /引用的材料版本与发布材料不一致/);
    assert.throws(() => runtime.publish({ ...candidate, material: reading.material,
      practice: { ...candidate.practice, material: { ...material, version: material.version + 1 } },
    }), /引用的材料版本与发布材料不一致/);
    assert.throws(() => runtime.start(student, open),
      error => error instanceof LearningError && error.status === 404 && error.code === "PRACTICE_NOT_FOUND");
    assert.deepEqual(recordedCounts(path), [0, 0, 0, 0, 0, 0, 0]);
  } finally {
    runtime.close();
  }
});

test("活动的真实材料记录断开时公开读入口拒绝返回题面", t => {
  const path = scenarioDatabase(t);
  let activityId: string;
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish({ ...candidate, material: reading.material,
      practice: { ...candidate.practice, material: reading.practice.material },
    });
    activityId = runtime.start(student, open).activityId;
  } finally {
    runtime.close();
  }
  {
    using broken = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    broken.prepare("DELETE FROM materials WHERE id = ? AND version = ?").run(reading.material.id, reading.material.version);
  }
  const reopened = openLearningRuntime({ databasePath: path });
  try {
    assert.throws(() => reopened.read(student, activityId), /活动引用的已发布材料不存在/);
  } finally {
    reopened.close();
  }
});
