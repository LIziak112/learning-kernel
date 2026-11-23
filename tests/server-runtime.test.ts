import { strict as assert } from "node:assert";
import { test } from "node:test";
import reading from "../practices/reading-library.json" with { type: "json" };
import { readingPublicationSchema } from "../src/contracts/reading-publication.ts";
import { startActivity } from "../src/kernel/activity.ts";
import { openDatabase } from "../src/kernel/database.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { LearningError, openLearningRuntime } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const publication = { ...readingPublicationSchema.parse(reading), scoringKey: reading.scoringKey };
const owner = { role: "student", id: "student-1" } as const;
const opening = {
  protocolVersion: 1, operationId: "open", practiceId: publication.practice.id, practiceVersion: publication.practice.version,
} as const;

function forbidden(error: unknown) {
  assert.ok(error instanceof LearningError);
  assert.equal(error.status, 403);
  assert.equal(error.code, "FORBIDDEN");
  return true;
}

test("公开服务入口按指定发布版本开卷，拒绝未授权或无效调用且不留活动", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  const facts = openDatabase(path);
  try {
    runtime.publish(publication);
    runtime.publish({
      ...publication,
      practice: { ...publication.practice, version: opening.practiceVersion + 1, title: "同练法的新版本" },
    });

    const reviewer = { role: "reviewer", id: owner.id };
    assert.throws(() => Reflect.apply(runtime.start, runtime, [reviewer, opening]), forbidden);
    assert.throws(() => runtime.start(owner, { ...opening, practiceVersion: 0 }), { name: "ZodError" });
    const activities = facts.prepare("SELECT count(*) AS count FROM activities");
    assert.equal(activities.get()?.count, 0);

    const receipt = runtime.start(owner, opening);
    const activity = runtime.read(owner, receipt.activityId);
    assert.equal(activity.activityId, receipt.activityId);
    assert.equal(activity.stepAttemptId, receipt.stepAttemptId);
    assert.equal(activity.title, publication.practice.title);
    assert.throws(() => Reflect.apply(runtime.read, runtime, [reviewer, receipt.activityId]), forbidden);
    assert.throws(() => runtime.read(owner, "invalid-activity-id"), { name: "ZodError" });
    assert.deepEqual(runtime.start(owner, opening), receipt);
    assert.equal(activities.get()?.count, 1);
  } finally {
    facts.close();
    runtime.close();
  }
});

test("活动学生被撤权后，公开服务入口拒绝读取和重发原开卷操作", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  const management = openDatabase(path);
  try {
    runtime.publish(publication);
    const teacher = "assigned-teacher";
    const receipt = startActivity(management, owner.id, opening, () => new Date(), teacher);
    assert.equal(runtime.read(owner, receipt.activityId).activityId, receipt.activityId);
    assert.deepEqual(runtime.start(owner, opening), receipt);

    assert.deepEqual(manageReading(management, teacher, receipt.activityId, "revokeStudent"), { studentActive: false });
    assert.throws(() => runtime.read(owner, receipt.activityId), forbidden);
    assert.throws(() => runtime.start(owner, opening), forbidden);
  } finally {
    management.close();
    runtime.close();
  }
});
