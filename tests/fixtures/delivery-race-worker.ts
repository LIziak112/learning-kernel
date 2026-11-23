import { z } from "zod";
import { LearningError, openLearningRuntime } from "../../src/server.ts";
import { raceInput } from "./delivery-race.ts";

const [databasePath, mode, startAt, stepAttemptId, activityId] = z.tuple([
  z.string(), z.enum(["question", "finish"]), z.coerce.number(), z.uuid(), z.uuid(),
]).parse(process.argv.slice(2));
const runtime = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => true });
try {
  while (Date.now() < startAt) continue;
  const receipt = runtime.confirmQuestionDelivery({ role: "student", id: "racer" }, activityId, raceInput(mode, stepAttemptId));
  console.log(JSON.stringify({ status: "confirmed", slotId: receipt.slotId }));
} catch (error) {
  if (!(error instanceof LearningError)) throw error;
  console.log(JSON.stringify({ status: "rejected", code: error.code }));
} finally {
  runtime.close();
}
