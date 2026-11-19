import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { z } from "zod";
import type { ZodType } from "zod";
import reading from "../../practices/reading-library.json" with { type: "json" };
import { startReceipt, submissionReceipt } from "../../src/contracts/reading.ts";
import { readingAnswer, readingAnswerDraft, readingDraftReceipt } from "../../src/contracts/reading-runtime.ts";
import { createLearningServer } from "../../src/host/server.ts";

export const firstChoices = { q1: "A", q2: "B", q3: "A" };
export const secondChoices = { q1: "B", q2: "A", q3: "B" };
export const firstClock = Date.parse("2026-11-19T08:00:00Z");
export const deadline = firstClock + 8 * 60_000;
export const sessions = new Map([["window-a", "student-1"], ["window-b", "student-1"], ["other", "student-2"]]);
export const reviewerSessions = new Map([["teacher", "teacher-1"], ["other-teacher", "teacher-2"]]);

export const selectionRanges = [
  { role: "observation", paragraphId: "p2", start: 0, end: 22 },
  { role: "condition", paragraphId: "p3", start: 0, end: 18 },
];

export const answerSubmission = z.object({ receipt: submissionReceipt, answer: readingAnswer });
export const readingState = startReceipt.extend({
  status: z.enum(["active", "completed"]),
  submission: answerSubmission.optional(),
  assessment: z.union([
    z.strictObject({ status: z.literal("pending") }),
    z.strictObject({ status: z.literal("complete"), correctCount: z.int(), questionCount: z.int() }),
  ]).optional(),
}).passthrough();

export function scenarioDatabase(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-scenario-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "scenario.sqlite");
}

type ServerOverrides = Partial<Parameters<typeof createLearningServer>[0]>;

export async function withScenarioServer<T>(
  databasePath: string, options: ServerOverrides, run: (origin: string) => Promise<T>, factory = createLearningServer,
) {
  const server = factory({
    databasePath, publication: reading, sessions, reviewerSessions, assignedReviewer: "teacher-1",
    evaluateAutomatically: false, ...options,
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export function get(origin: string, path: string, session = "window-a") {
  return fetch(origin + path, { headers: { cookie: `learning_session=${session}` } });
}

export function post(origin: string, path: string, body: Record<string, unknown>, session = "window-a") {
  return fetch(origin + path, {
    method: "POST",
    headers: { cookie: `learning_session=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, ...body }),
    signal: AbortSignal.timeout(8000),
  });
}

export async function result<T>(request: Promise<Response>, schema: ZodType<T>) {
  const response = await request;
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return schema.parse(JSON.parse(body));
}

export async function rejection(request: Promise<Response>, status: number, code: string) {
  const response = await request;
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code });
}

export async function prepareScenario(origin: string, practiceId = reading.practice.id) {
  const start = await result(post(origin, "/api/activities", { operationId: "start", practiceId }), startReceipt);
  const path = `/api/activities/${start.activityId}`;
  const first = { stepAttemptId: start.stepAttemptId, slotId: "quotes" };
  const selection = await result(post(origin, path + "/drafts", { ...first, ranges: selectionRanges }), readingDraftReceipt);
  const quote = await result(post(origin, path + "/submissions", {
    ...first, operationId: "evidence", draft: selection.draft,
  }), submissionReceipt);
  const answer = await result(get(origin, path), readingState);
  return { start, path, quote, binding: { stepAttemptId: answer.stepAttemptId, slotId: "choices" } };
}

export async function prepareAnswers(
  origin: string, scenario: Awaited<ReturnType<typeof prepareScenario>>,
  choices: Record<string, string>, operationId: string, session = "window-a",
) {
  const saved = await result(post(origin, scenario.path + "/drafts", {
    ...scenario.binding, choices, references: { basis: scenario.quote.id },
  }, session), readingAnswerDraft);
  return { ...scenario.binding, operationId, draft: saved.draft };
}

export function countFacts(database: DatabaseSync) {
  const counts = database.prepare(`
    SELECT (SELECT COUNT(*) FROM submissions) AS submissions,
      (SELECT COUNT(*) FROM performances WHERE unit_id = 'wholeSelection') AS selections,
      (SELECT COUNT(*) FROM performances WHERE unit_id LIKE 'question:%') AS answers,
      (SELECT COUNT(*) FROM completions) AS completions,
      (SELECT COUNT(*) FROM evaluation_tasks) AS tasks,
      (SELECT COUNT(*) FROM automatic_verdicts) AS verdicts
  `).get();
  assert.ok(counts);
  return { ...counts };
}
