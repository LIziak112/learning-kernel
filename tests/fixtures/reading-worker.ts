import { writeSync } from "node:fs";
import { z } from "zod";
import reading from "../../practices/reading-library.json" with { type: "json" };
import { createLearningServer } from "../../src/host/server.ts";
import type { RuntimeCheckpoint } from "../../src/kernel/runtime-checkpoint.ts";
import { reviewerSessions, sessions } from "./online-reading.ts";

const options = z.strictObject({
  file: z.string().min(1),
  now: z.number(),
  evaluateAutomatically: z.boolean(),
  stopAt: z.enum([
    "beforeConfirmationCommit", "afterConfirmationCommit", "beforeEvaluation",
    "afterAutomaticVerdict", "beforeEvaluationComplete",
  ]).optional(),
}).parse(JSON.parse(process.argv[2] ?? "null"));

const checkpoint: RuntimeCheckpoint = event => {
  if (event.point !== options.stopAt) return;
  if ("operationId" in event && event.operationId !== "turn-a") return;
  if (event.point === "afterAutomaticVerdict" && event.questionId !== "q1") return;
  writeSync(1, JSON.stringify(event) + "\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const server = createLearningServer({
  databasePath: options.file,
  publication: reading,
  sessions,
  reviewerSessions,
  assignedReviewer: "teacher-1",
  clock: () => new Date(options.now),
  evaluateAutomatically: options.evaluateAutomatically,
  checkpoint,
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务没有可用端口");
  writeSync(1, JSON.stringify({ point: "listening", port: address.port }) + "\n");
});
process.on("message", command => {
  if (command === "stop") server.close(() => process.disconnect?.());
});
