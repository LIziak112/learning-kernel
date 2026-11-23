import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import { questionSlots, racePublication } from "./fixtures/delivery-race.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const run = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/delivery-race-worker.ts", import.meta.url));
const outcome = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("confirmed"), slotId: z.string() }),
  z.strictObject({ status: z.literal("rejected"), code: z.string() }),
]);
const student = { role: "student", id: "racer" } as const;

function prepare(databasePath: string, round: number) {
  const runtime = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => true });
  try {
    if (round === 0) runtime.publish(racePublication);
    const activity = runtime.start(student, { protocolVersion: 1, operationId: `race-${round}`, practiceId: "delivery-race", practiceVersion: 1 });
    for (const questionId of ["first", "second"]) {
      runtime.saveQuestionDeliveryDraft(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
        slotId: "answers", questionId, questionVersion: 1, operationId: "save", baseRevision: 0, value: true });
    }
    return activity;
  } finally { runtime.close(); }
}

function deliveredQuestions(database: DatabaseSync, stepAttemptId: string) {
  return database.prepare(`SELECT s.slot_id AS slotId, v.selection AS content FROM submissions s
    JOIN work_versions v ON v.work_id = s.work_id AND v.version = s.work_version WHERE s.step_attempt_id = ?`).all(stepAttemptId)
    .flatMap(row => z.object({ questions: z.array(z.object({ questionId: z.string() })) }).parse(JSON.parse(String(row.content))).questions)
    .map(({ questionId }) => questionId).toSorted();
}

test("逐题交付与提前收卷同时到达：每题恰好交付一次，活动只完成一次，落败方得到可解释的冲突", async t => {
  const databasePath = scenarioDatabase(t);
  const seen = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const activity = prepare(databasePath, round);
    const startAt = String(Date.now() + 400);
    const [question, finish] = await Promise.all((["question", "finish"] as const).map(async mode => {
      const { stdout } = await run(process.execPath, [worker, databasePath, mode, startAt, activity.stepAttemptId, activity.activityId]);
      return outcome.parse(JSON.parse(stdout.trim()));
    }));
    assert.ok(question && finish);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(deliveredQuestions(database, activity.stepAttemptId), ["first", "second"]);
    assert.equal(database.prepare("SELECT count(*) AS n FROM completions WHERE activity_id = ?").get(activity.activityId)?.n, 1);
    assert.equal(finish.status, "confirmed");
    assert.equal(finish.slotId, "answers");
    if (question.status === "confirmed") {
      assert.equal(question.slotId, questionSlots.first);
      seen.add("question-first");
    } else {
      assert.equal(question.code, "ALREADY_SUBMITTED");
      seen.add("finish-first");
    }
  }
  assert.ok(seen.size >= 1);
  t.diagnostic(`观察到的先后：${[...seen].toSorted().join("、")}`);
});
