import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import type { ZodType } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { materialSchema, startReceipt, submissionReceipt, versionRef } from "../src/contracts/reading.ts";
import { readingDraftReceipt, readingSelection } from "../src/contracts/reading-runtime.ts";
import { createLearningServer } from "../src/host/server.ts";

const activityView = startReceipt.extend({
  formatVersion: z.literal(1),
  title: z.string(),
  material: materialSchema,
  step: z.strictObject({ id: z.string(), instructions: z.string(), tool: versionRef, submit: z.unknown() }),
  status: z.literal("active"),
  inputs: z.record(z.string(), z.unknown()),
});

const ranges = [
  { role: "observation", paragraphId: "p2", start: 0, end: 22 },
  { role: "condition", paragraphId: "p3", start: 0, end: 18 },
];

test("确认两段选据后放行答题，第二步读取的引文保留原材料位置", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const first = await readResult(get(origin, path), activityView);
    assert.equal(first.step.id, "evidence");
    assert.equal(first.stepAttemptId, started.stepAttemptId);
    assert.deepEqual(Object.keys(first.inputs), ["passage"]);
    assert.deepEqual(first.inputs.passage, { from: "material", positionId: "evidence-passage" });
    const saved = await readResult(post(origin, path + "/drafts", {
      stepAttemptId: first.stepAttemptId, slotId: "quotes", ranges,
    }), readingDraftReceipt);
    assert.deepEqual(saved.selection.material, reading.practice.material);
    assert.equal(saved.selection.positionId, "evidence-passage");
    assert.deepEqual(saved.selection.ranges.map(item => [item.role, item.range.paragraphId, item.text]), [
      ["observation", "p2", reading.material.paragraphs[1]?.text],
      ["condition", "p3", reading.material.paragraphs[2]?.text],
    ]);
    const input = {
      stepAttemptId: first.stepAttemptId, slotId: "quotes", draft: saved.draft, operationId: "confirm",
    };
    const receipt = await readResult(post(origin, path + "/submissions", input), submissionReceipt);
    const second = await readResult(get(origin, path), activityView);
    assert.equal(second.step.id, "decide");
    assert.notEqual(second.stepAttemptId, first.stepAttemptId);
    assert.deepEqual(second.inputs.passage, { from: "material", positionId: "decide-passage" });
    assert.deepEqual(second.inputs.quotes, { from: "submission", receipt, selection: saved.selection });
    assert.deepEqual(second.inputs.items, { from: "questions", questions: reading.practice.questions });
    assert.deepEqual(await readResult(post(origin, path + "/submissions", input), submissionReceipt), receipt);
    assert.deepEqual(await startReading(origin), started);
    await assertError(post(origin, path + "/submissions", { ...input, operationId: "other-operation" }), 409, "ALREADY_SUBMITTED");
    const detail = z.strictObject({ receipt: submissionReceipt, selection: readingSelection });
    assert.deepEqual(await readResult(get(origin, path + "/submissions/" + receipt.id), detail), { receipt, selection: saved.selection });
    await assertError(get(origin, path, "other"), 403, "FORBIDDEN");
    await assertError(get(origin, path + "/submissions/" + receipt.id, "other"), 403, "FORBIDDEN");
    await assertError(post(origin, path + "/submissions", input, "other"), 403, "FORBIDDEN");
    const other = await startReading(origin, "start", "other");
    await assertError(get(origin, `/api/activities/${other.activityId}/submissions/${receipt.id}`, "other"), 403, "FORBIDDEN");
    using database = new DatabaseSync(databasePath, { readOnly: true });
    const attempts = database.prepare("SELECT step_id FROM step_attempts WHERE activity_id = ? ORDER BY ordinal").all(started.activityId);
    assert.deepEqual(attempts.map(row => row.step_id), ["evidence", "decide"]);
    const performances = database.prepare("SELECT submission_id, target_id FROM performances").all();
    assert.deepEqual(performances.map(row => [row.submission_id, row.target_id]), [[receipt.id, "cite"]]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 1);
  });
});

test("少一段或两用途同段仍保稿，直到完整提交才放行第二步", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const binding = { stepAttemptId: started.stepAttemptId, slotId: "quotes" };
    const observation = ranges[0];
    assert.ok(observation);
    const partial = await readResult(post(origin, path + "/drafts", { ...binding, ranges: [observation] }), readingDraftReceipt);
    assert.equal(partial.selection.ranges.length, 1);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: partial.draft, operationId: "confirm" }),
      422, "INCOMPLETE_SELECTION");
    const same = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: partial.draft.id, ranges: [observation, { ...observation, role: "condition" }],
    }), readingDraftReceipt);
    assert.equal(same.draft.version, 2);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: same.draft, operationId: "confirm" }),
      422, "SELECTION_REQUIRES_DISTINCT_PARAGRAPHS");
    const duplicate = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: same.draft.id, ranges: ranges.map(range => ({ ...range, role: "observation" })),
    }), readingDraftReceipt);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: duplicate.draft, operationId: "confirm" }),
      422, "INCOMPLETE_SELECTION");
    const first = await readResult(get(origin, path), activityView);
    assert.equal(first.stepAttemptId, started.stepAttemptId);
    assert.equal(first.step.id, "evidence");
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(database.prepare("SELECT version FROM work_versions ORDER BY version").all().map(row => row.version), [1, 2, 3]);
    for (const table of ["submissions", "performances", "completions"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    const full = await readResult(post(origin, path + "/drafts", { ...binding, ranges, workId: same.draft.id }), readingDraftReceipt);
    await readResult(post(origin, path + "/submissions", { ...binding, draft: full.draft, operationId: "confirm" }), submissionReceipt);
    assert.equal((await readResult(get(origin, path), activityView)).step.id, "decide");
  });
});

test("不同步骤复用槽位名称时只交付声明指定的原引文", async t => {
  const [first, answer] = reading.practice.steps;
  assert.ok(first && answer?.inputs.quotes);
  const second = {
    ...first, id: "follow-up", requires: first.id,
    inputs: { passage: { from: "material", positionId: "follow-up-passage" } },
  };
  const third = {
    ...answer, requires: second.id,
    inputs: { ...answer.inputs, quotes: { ...answer.inputs.quotes, stepId: second.id } },
  };
  const publication = { ...reading, practice: { ...reading.practice, steps: [first, second, third] } };
  await runReadingServer(temporaryPath(t), publication, async origin => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const firstReceipt = await confirmSelection(origin, path, started.stepAttemptId, "first");
    const middle = await readResult(get(origin, path), activityView);
    assert.equal(middle.step.id, second.id);
    const secondReceipt = await confirmSelection(origin, path, middle.stepAttemptId, "second");
    const last = await readResult(get(origin, path), activityView);
    assert.equal(last.step.id, third.id);
    const quotes = z.object({ from: z.literal("submission"), receipt: submissionReceipt, selection: readingSelection })
      .parse(last.inputs.quotes);
    assert.deepEqual(quotes.receipt, secondReceipt);
    assert.notEqual(quotes.receipt.id, firstReceipt.id);
    assert.equal(quotes.selection.positionId, "follow-up-passage");
  });
});

test("历史声明的工具或材料绑定不可用时，服务拒绝保存选区", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}/drafts`;
    using database = new DatabaseSync(databasePath);
    const update = database.prepare("UPDATE practices SET definition = ? WHERE id = ? AND version = ?");
    const [first, second] = reading.practice.steps;
    assert.ok(first && second);
    const input = { stepAttemptId: started.stepAttemptId, slotId: "quotes", ranges };
    for (const sample of [
      { step: { ...first, tool: { ...first.tool, version: 42 } }, status: 422, code: "INVALID_SLOT" },
      { step: { ...first, inputs: {} }, status: 409, code: "PRACTICE_NOT_RUNNABLE" },
    ]) {
      const value = { ...reading.practice, steps: [sample.step, second] };
      update.run(JSON.stringify(value), value.id, value.version);
      await assertError(post(origin, path, input), sample.status, sample.code);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM works").get()?.count, 0);
  });
});

async function confirmSelection(origin: string, path: string, stepAttemptId: string, operationId: string) {
  const binding = { stepAttemptId, slotId: "quotes" };
  const saved = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
  return readResult(post(origin, path + "/submissions", { ...binding, draft: saved.draft, operationId }), submissionReceipt);
}

test("已交引文跨重启与升版仍固定在原活动的作品和材料版本", async t => {
  const filename = temporaryPath(t);
  const previous = await runReadingServer(filename, reading, async origin => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const binding = { stepAttemptId: started.stepAttemptId, slotId: "quotes" };
    const saved = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
    const receipt = await readResult(post(origin, path + "/submissions", {
      ...binding, draft: saved.draft, operationId: "confirm",
    }), submissionReceipt);
    const revised = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: saved.draft.id, ranges: ranges.map(range => ({ ...range, end: range.end - 1 })),
    }), readingDraftReceipt);
    assert.equal(revised.draft.version, 2);
    assert.notDeepEqual(revised.selection, saved.selection);
    await assertError(post(origin, path + "/submissions", {
      ...binding, draft: revised.draft, operationId: "confirm",
    }), 409, "OPERATION_CONFLICT");
    return { started, path, receipt, selection: saved.selection };
  });
  const material = { ...reading.material, version: 2, title: "第二版图书馆原文" };
  const practice = { ...reading.practice, version: 2, material: { id: material.id, version: material.version } };
  await runReadingServer(filename, { ...reading, material, practice }, async origin => {
    const newStart = await startReading(origin, "start-new");
    const fresh = await readResult(get(origin, `/api/activities/${newStart.activityId}`), activityView);
    assert.equal(fresh.material.version, 2);
    assert.equal(fresh.material.title, material.title);
    const restored = await readResult(get(origin, previous.path), activityView);
    assert.equal(restored.material.version, 1);
    assert.equal(restored.step.id, "decide");
    assert.deepEqual(restored.inputs.quotes, { from: "submission", receipt: previous.receipt, selection: previous.selection });
    assert.deepEqual(await startReading(origin), previous.started);
  });
});

test("第二步只接收声明绑定的工具输入，且另一活动的草稿不能交到本步", async t => {
  await withReadingServer(t, async origin => {
    const a = await startReading(origin);
    const b = await startReading(origin, "another");
    const path = `/api/activities/${a.activityId}`;
    const binding = { stepAttemptId: a.stepAttemptId, slotId: "quotes" };
    await assertError(post(origin, path + "/drafts", { range: { paragraphId: "p2", start: 0, end: 1 } }),
      422, "INVALID_DRAFT");
    await assertError(post(origin, path + "/drafts", { ...binding, slotId: "missing", ranges }), 422, "INVALID_SLOT");
    await assertError(post(origin, path + "/drafts", { ...binding, stepAttemptId: b.stepAttemptId, ranges }), 403, "FORBIDDEN");
    await assertError(post(origin, path + "/drafts", {
      ...binding, ranges: ranges.map(range => ({ ...range, role: "unallowed" })),
    }), 422, "INVALID_SELECTION");
    const foreign = await readResult(post(origin, `/api/activities/${b.activityId}/drafts`, {
      ...binding, stepAttemptId: b.stepAttemptId, ranges,
    }), readingDraftReceipt);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: foreign.draft, operationId: "confirm" }), 403, "FORBIDDEN");
    const own = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
    await readResult(post(origin, path + "/submissions", { ...binding, draft: own.draft, operationId: "confirm" }), submissionReceipt);
    const second = await readResult(get(origin, path), activityView);
    await assertError(post(origin, path + "/drafts", {
      ...binding, stepAttemptId: second.stepAttemptId, slotId: "choices", ranges,
    }), 422, "INVALID_SLOT");
  });
});

test("写入下一步骤失败时，选据确认及原始表现一起回滚", async t => {
  t.mock.method(console, "error", () => undefined);
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const binding = { stepAttemptId: started.stepAttemptId, slotId: "quotes" };
    const saved = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
    using database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER fail_advance BEFORE INSERT ON step_attempts
      WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'test advance failure'); END;
    `);
    const request = { ...binding, draft: saved.draft, operationId: "confirm" };
    await assertError(post(origin, path + "/submissions", request), 500, "INTERNAL_ERROR");
    const current = await readResult(get(origin, path), activityView);
    assert.equal(current.stepAttemptId, started.stepAttemptId);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM performances").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_versions").get()?.count, 1);
    database.exec("DROP TRIGGER fail_advance");
    await readResult(post(origin, path + "/submissions", request), submissionReceipt);
    assert.equal((await readResult(get(origin, path), activityView)).step.id, "decide");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 1);
  });
});

async function withReadingServer(t: TestContext, run: (origin: string, path: string) => Promise<void>) {
  const path = temporaryPath(t);
  await runReadingServer(path, reading, origin => run(origin, path));
}

function temporaryPath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-progress-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "progress.sqlite");
}

async function runReadingServer<T>(path: string, publication: unknown, run: (origin: string) => Promise<T>) {
  const server = createLearningServer({
    databasePath: path,
    publication,
    sessions: new Map([["owner", "student-1"], ["other", "student-2"]]),
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

function startReading(origin: string, operationId = "start", session = "owner") {
  return readResult(post(origin, "/api/activities", { practiceId: reading.practice.id, operationId }, session), startReceipt);
}

function post(origin: string, path: string, body: Record<string, unknown>, session = "owner") {
  return fetch(origin + path, {
    method: "POST",
    headers: { cookie: `learning_session=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, ...body }),
  });
}

function get(origin: string, path: string, session = "owner") {
  return fetch(origin + path, { headers: { cookie: `learning_session=${session}` } });
}

async function readResult<T>(request: Promise<Response>, contract: ZodType<T>) {
  const response = await request;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return contract.parse(JSON.parse(text));
}

async function assertError(request: Promise<Response>, status: number, code: string) {
  const response = await request;
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code });
}
