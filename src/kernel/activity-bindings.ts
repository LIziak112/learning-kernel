import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { activityBinding, activityBindingClaims } from "../contracts/activity-bindings.ts";
import type { ActivityBindingClaims, ActivityOpeningKey } from "../contracts/activity-bindings.ts";
import { LearningError } from "./learning-error.ts";

const snapshotPath = z.string().min(1);

export function verifyActivityBindings(databasePath: string, input: ActivityBindingClaims): void {
  const expected = claimOpenings(activityBindingClaims.parse(input));
  using database = new DatabaseSync(snapshotPath.parse(databasePath), { readOnly: true });
  const identities = database.prepare(
    "SELECT id AS activityId, student_id AS studentId, start_operation_id AS operationId FROM activities",
  );
  for (const identity of identities.iterate()) {
    const parsed = activityBinding.safeParse(identity);
    if (!parsed.success) throw bindingMismatch();
    const key = openingKey(parsed.data);
    const activityId = expected.get(key);
    if (!expected.delete(key) || (activityId !== undefined && activityId !== parsed.data.activityId)) throw bindingMismatch();
  }
  for (const activityId of expected.values()) {
    if (activityId !== undefined) throw bindingMismatch();
  }
}

function claimOpenings({ bindings, openingIntents }: ActivityBindingClaims) {
  const expected = new Map<string, string | undefined>();
  for (const binding of bindings) addOpening(expected, binding, binding.activityId);
  for (const intent of openingIntents) addOpening(expected, intent);
  return expected;
}

function addOpening(expected: Map<string, string | undefined>, opening: ActivityOpeningKey, activityId?: string) {
  const key = openingKey(opening);
  if (expected.has(key)) throw bindingMismatch();
  expected.set(key, activityId);
}

function openingKey({ studentId, operationId }: ActivityOpeningKey) {
  return JSON.stringify([studentId, operationId]);
}

function bindingMismatch() {
  return new LearningError(409, "ACTIVITY_BINDINGS_MISMATCH");
}
