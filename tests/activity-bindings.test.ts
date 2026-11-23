import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { openLearningRuntime, verifyActivityBindings } from "../src/server.ts";
import type { ActivityBindingClaims } from "../src/server.ts";
import { frozenChoicePublication, practiceId } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const empty: ActivityBindingClaims = { protocolVersion: 1, bindings: [], openingIntents: [] };
const mismatch = { status: 409, code: "ACTIVITY_BINDINGS_MISMATCH" };

test("逐一核验持久活动、所有者和开卷键，无需取回任何活动正文", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  const first = { studentId: "a:b", operationId: "c" };
  const second = { studentId: "a", operationId: "b:c" };
  const start = { protocolVersion: 1, practiceId, practiceVersion: 1 } as const;
  const bind = ({ studentId, operationId }: typeof first) => ({
    studentId, operationId,
    activityId: runtime.start({ role: "student", id: studentId }, { ...start, operationId }).activityId,
  });
  let one;
  let two;
  try {
    runtime.publish(frozenChoicePublication);
    one = bind(first);
    two = bind(second);
  } finally {
    runtime.close();
  }

  const both = { ...empty, bindings: [one, two] };
  const before = readFileSync(path);
  assert.equal(verifyActivityBindings(path, both), undefined);
  assert.equal(verifyActivityBindings(path, { ...empty, bindings: [one], openingIntents: [second] }), undefined);
  assert.equal(verifyActivityBindings(path, { ...empty, openingIntents: [first, second, { studentId: "pending", operationId: "open" }] }), undefined);
  for (const claims of [
    empty,
    { ...empty, bindings: [one] },
    { ...both, bindings: [one, two, { ...one, operationId: "extra" }] },
    { ...both, bindings: [one, { ...two, studentId: one.studentId }] },
    { ...both, bindings: [one, { ...two, operationId: "wrong-operation" }] },
    { ...both, bindings: [{ ...one, activityId: two.activityId }, two] },
    { ...both, bindings: [one, one, two] },
    { ...both, openingIntents: [first] },
    { ...empty, openingIntents: [first, second, second] },
  ]) {
    assert.throws(() => verifyActivityBindings(path, claims), mismatch);
  }
  const invalid = { ...both, bindings: [{ ...one, ignoredField: "unrecognized" }, two] };
  assert.throws(() => Reflect.apply(verifyActivityBindings, undefined, [path, invalid]), { name: "ZodError" });
  assert.deepEqual(readFileSync(path), before);
});

test("空的有效数据库可核验，缺少或无效文件按失败处理且不会创建或修复文件", t => {
  const path = scenarioDatabase(t);
  assert.throws(() => verifyActivityBindings(path, empty));
  assert.equal(existsSync(path), false);
  writeFileSync(path, "broken sqlite");
  const invalid = readFileSync(path);
  assert.throws(() => verifyActivityBindings(path, empty));
  assert.deepEqual(readFileSync(path), invalid);

  const available = scenarioDatabase(t);
  openLearningRuntime({ databasePath: available }).close();
  const before = readFileSync(available);
  assert.equal(verifyActivityBindings(available, empty), undefined);
  assert.equal(verifyActivityBindings(available, { ...empty, openingIntents: [{ studentId: "one", operationId: "pending" }] }), undefined);
  assert.throws(() => verifyActivityBindings(available, {
    ...empty, bindings: [{ activityId: "2a63f3f5-50c5-42a7-8cb8-b0c006ad3c43", studentId: "one", operationId: "pending" }],
  }), mismatch);
  assert.deepEqual(readFileSync(available), before);
});
