import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ZodType } from "zod";
import publication from "../practices/single-quote.json" with { type: "json" };
import { activityDetail, draftReceipt, startReceipt, submissionDetail, submissionReceipt } from "../src/contracts/reading.ts";
import type { SubmitInput } from "../src/contracts/reading.ts";
import { createLearningServer } from "../src/host/server.ts";

const sessions = new Map([["first-session", "student-1"], ["other-session", "student-2"]]);

test("登录学生通过 HTTP 启动单步练法并收到带步骤尝试的回执", async t => {
  const server = createLearningServer({ databasePath: temporaryDatabasePath(t), publication, sessions });
  try {
    const origin = await listen(server);
    const input = {
      protocolVersion: 1,
      practiceId: publication.practice.id,
      operationId: "start-1",
    };
    await denied(post(origin, "/api/activities", input, "missing-session"), 401, "UNAUTHENTICATED");
    await denied(post(origin, "/api/activities", { ...input, studentId: "student-2" }), 400, "BAD_REQUEST");
    await result(post(origin, "/api/activities", input), startReceipt);
    await denied(post(origin, "/api/activities", { ...input, practiceId: "other" }), 409, "OPERATION_CONFLICT");
    await denied(post(origin, "/api/activities", { ...input, practiceId: "other", operationId: "unknown" }), 404, "PRACTICE_NOT_FOUND");
  } finally {
    await close(server);
  }
});

const renamed = {
  ...publication,
  practice: {
    ...publication.practice,
    id: "another-practice",
    steps: publication.practice.steps.map(step => ({
      ...step,
      id: "another-step",
      slotId: "another-slot",
      positionId: "another-position",
    })),
  },
};

for (const definition of [publication, renamed]) {
  test(`单步证据提交、原回执重取及升版重开（${definition.practice.id}）`, async t => {
    const databasePath = temporaryDatabasePath(t);
    const server = createLearningServer({ databasePath, publication: definition, sessions });
    const step = definition.practice.steps[0];
    const paragraph = definition.material.paragraphs[0];
    assert.ok(step && paragraph);
    const originalRange = { paragraphId: paragraph.id, start: 0, end: 10 };
    const start = { protocolVersion: 1, operationId: "start-1", practiceId: definition.practice.id };
    let path: string;
    let submissionPath: string;
    let submit: SubmitInput;
    let original: ReturnType<typeof submissionDetail.parse>;

    try {
      const origin = await listen(server);
      const activity = await result(post(origin, "/api/activities", start), startReceipt);
      assert.deepEqual(await result(post(origin, "/api/activities", start), startReceipt), activity);
      path = `/api/activities/${activity.activityId}`;
      const active = await result(get(origin, path), activityDetail);
      assert.equal(active.status, "active");
      assert.equal(active.submission, null);
      assert.deepEqual(active.step, step);
      assert.deepEqual(active.material, definition.material);
      await denied(get(origin, path, "other-session"), 403, "FORBIDDEN");

      const save = { protocolVersion: 1, range: originalRange };
      await denied(post(origin, path + "/drafts", save, "other-session"), 403, "FORBIDDEN");
      await denied(post(origin, path + "/drafts", { ...save, range: { ...originalRange, end: 1000 } }), 422, "INVALID_SELECTION");
      const first = await result(post(origin, path + "/drafts", save), draftReceipt);
      assert.equal(first.draft.version, 1);
      assert.deepEqual(first.selection, {
        material: definition.practice.material,
        positionId: step.positionId,
        range: originalRange,
        text: paragraph.text.slice(0, 10),
      });
      submit = { protocolVersion: 1, operationId: "submit-1", stepAttemptId: activity.stepAttemptId, slotId: step.slotId, draft: first.draft };
      await denied(post(origin, path + "/submissions", { ...submit, slotId: "invalid" }), 422, "INVALID_SLOT");
      await denied(post(origin, path + "/submissions", { ...submit, stepAttemptId: randomUUID() }), 403, "FORBIDDEN");
      await denied(post(origin, path + "/submissions", { ...submit, draft: { ...first.draft, version: 2 } }), 403, "FORBIDDEN");

      const lost = await post(origin, path + "/submissions", submit);
      assert.equal(lost.status, 200);
      await lost.body?.cancel();
      using database = new DatabaseSync(databasePath, { readOnly: true });
      const committed = submissionReceipt.parse(database.prepare(`
        SELECT id, step_attempt_id AS stepAttemptId, slot_id AS slotId, confirmed_at AS confirmedAt FROM submissions
      `).get());
      const receipt = await result(post(origin, path + "/submissions", submit), submissionReceipt);
      assert.deepEqual(receipt, committed);
      submissionPath = path + "/submissions/" + receipt.id;
      original = { receipt, selection: first.selection };
      await denied(get(origin, submissionPath, "other-session"), 403, "FORBIDDEN");
      await denied(post(origin, path + "/submissions", submit, "other-session"), 403, "FORBIDDEN");
      await denied(post(origin, path + "/submissions", { ...submit, operationId: "new-submit" }), 409, "ALREADY_SUBMITTED");
      await denied(post(origin, path + "/submissions", { ...submit, slotId: "altered" }), 409, "OPERATION_CONFLICT");

      const revised = await result(post(origin, path + "/drafts", {
        ...save,
        workId: first.draft.id,
        range: { ...originalRange, start: 10, end: 15 },
      }), draftReceipt);
      assert.deepEqual(revised.draft, { id: first.draft.id, version: 2 });
      assert.notEqual(revised.selection.text, first.selection.text);
      await denied(post(origin, path + "/submissions", { ...submit, draft: revised.draft }), 409, "OPERATION_CONFLICT");
      await denied(post(origin, path + "/submissions", { ...submit, draft: { ...submit.draft, id: randomUUID() } }), 409, "OPERATION_CONFLICT");
      assert.deepEqual(await result(get(origin, submissionPath), submissionDetail), original);

      assert.deepEqual(database.prepare("SELECT work_version FROM submissions").all().map(row => row.work_version), [1]);
      assert.deepEqual(database.prepare("SELECT target_id FROM performances WHERE submission_id = ?")
        .all(receipt.id).map(row => row.target_id), [step.targetId]);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM performances").get()?.count, 1);
      assert.deepEqual(database.prepare("SELECT submission_id FROM completions WHERE activity_id = ?")
        .all(activity.activityId).map(row => row.submission_id), [receipt.id]);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM completions").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evaluation_tasks").get()?.count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count, 1);
    } finally {
      await close(server);
    }

    const restarted = createLearningServer({ databasePath, publication: definition, sessions });
    try {
      const origin = await listen(restarted);
      const restored = await result(get(origin, path), activityDetail);
      assert.equal(restored.status, "completed");
      assert.deepEqual(restored.submission, original);
      assert.deepEqual(await result(get(origin, submissionPath), submissionDetail), original);
      assert.deepEqual(await result(post(origin, path + "/submissions", submit), submissionReceipt), original.receipt);
      await denied(get(origin, submissionPath, "other-session"), 403, "FORBIDDEN");
    } finally {
      await close(restarted);
    }
  });
}

test("HTTP 验证会话、请求大小和精确路由", async t => {
  const server = createLearningServer({ databasePath: temporaryDatabasePath(t), publication, sessions });
  try {
    const origin = await listen(server);
    const endpoint = origin + "/api/activities";
    const body = JSON.stringify({ protocolVersion: 1, operationId: "start-1", practiceId: publication.practice.id });
    const auth = { cookie: "another_cookie=value; learning_session=first-session" };
    await denied(fetch(endpoint, { method: "POST", body }), 401, "UNAUTHENTICATED");
    await denied(fetch(endpoint, { method: "POST", headers: { cookie: "other_learning_session=first-session" }, body }),
      401, "UNAUTHENTICATED");
    await denied(fetch(endpoint, { method: "POST", headers: auth, body }), 415, "JSON_REQUIRED");
    await denied(fetch(endpoint, { method: "POST", headers: auth }), 415, "JSON_REQUIRED");
    const headers = { ...auth, "content-type": "Application/JSON; charset=utf-8" };
    await denied(fetch(endpoint, { method: "POST", headers, body: "{" }), 400, "BAD_REQUEST");
    const maxSize = body.padEnd(64 * 1024);
    const started = await result(fetch(endpoint, { method: "POST", headers, body: maxSize }), startReceipt);
    await denied(fetch(endpoint, { method: "POST", headers, body: maxSize + " " }), 413, "BODY_TOO_LARGE");
    await denied(unfinishedRequest(endpoint, headers, maxSize + " "), 413, "BODY_TOO_LARGE");

    const path = `/api/activities/${started.activityId}`;
    await denied(get(origin, "/api/activities"), 404, "NOT_FOUND");
    await denied(post(origin, path, {}), 404, "NOT_FOUND");
    await denied(get(origin, path + "/drafts"), 404, "NOT_FOUND");
    await denied(get(origin, path + "/drafts/" + randomUUID()), 404, "NOT_FOUND");
    await denied(get(origin, path + "/submissions"), 404, "NOT_FOUND");
    await denied(post(origin, path + "/submissions/" + randomUUID(), {}), 404, "NOT_FOUND");
    await denied(get(origin, path + "/submissions/" + randomUUID()), 403, "FORBIDDEN");
  } finally {
    await close(server);
  }
});

test("未能完成事务时不产生提交、原始表现或完成，原操作可以恢复", async t => {
  const databasePath = temporaryDatabasePath(t);
  const server = createLearningServer({ databasePath, publication, sessions });
  t.mock.method(console, "error", () => undefined);
  try {
    const origin = await listen(server);
    const started = await result(post(origin, "/api/activities", {
      protocolVersion: 1, operationId: "start-1", practiceId: publication.practice.id,
    }), startReceipt);
    const path = `/api/activities/${started.activityId}`;
    const activity = await result(get(origin, path), activityDetail);
    const draft = await result(post(origin, path + "/drafts", {
      protocolVersion: 1, range: { paragraphId: "p1", start: 0, end: 10 },
    }), draftReceipt);
    const submit = {
      protocolVersion: 1, operationId: "submit-1", stepAttemptId: activity.stepAttemptId,
      slotId: activity.step.slotId, draft: draft.draft,
    };

    using database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER fail_completion BEFORE INSERT ON completions
      BEGIN SELECT RAISE(ABORT, '无法保存完成事实'); END;
    `);
    await denied(post(origin, path + "/submissions", submit), 500, "INTERNAL_ERROR");
    const after = await result(get(origin, path), activityDetail);
    assert.equal(after.status, "active");
    assert.equal(after.submission, null);
    for (const table of ["submissions", "performances", "completions"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_versions").get()?.count, 1);
    database.exec("DROP TRIGGER fail_completion");
    const confirmed = await result(post(origin, path + "/submissions", submit), submissionReceipt);
    assert.deepEqual(await result(get(origin, path + "/submissions/" + confirmed.id), submissionDetail), {
      receipt: confirmed, selection: draft.selection,
    });
  } finally {
    await close(server);
  }
});

test("选区验证段落和范围，其他活动的作品不能绑定到本活动", async t => {
  const databasePath = temporaryDatabasePath(t);
  const definition = {
    ...publication,
    material: { ...publication.material, paragraphs: [{ id: "p1", text: "白昼 夜晚" }] },
  };
  const server = createLearningServer({ databasePath, publication: definition, sessions });
  try {
    const origin = await listen(server);
    const start = { protocolVersion: 1, operationId: "start-1", practiceId: publication.practice.id };
    const first = await result(post(origin, "/api/activities", start), startReceipt);
    const second = await result(post(origin, "/api/activities", { ...start, operationId: "start-2" }), startReceipt);
    assert.notEqual(second.activityId, first.activityId);
    assert.notEqual(second.stepAttemptId, first.stepAttemptId);
    const firstPath = `/api/activities/${first.activityId}`;
    const secondPath = `/api/activities/${second.activityId}`;
    for (const range of [
      { paragraphId: "missing", start: 0, end: 1 },
      { paragraphId: "p1", start: 1, end: 1 },
      { paragraphId: "p1", start: 2, end: 3 },
    ]) {
      await denied(post(origin, firstPath + "/drafts", { protocolVersion: 1, range }), 422, "INVALID_SELECTION");
    }
    const save = { protocolVersion: 1, range: { paragraphId: "p1", start: 3, end: 5 } };
    const draft = await result(post(origin, firstPath + "/drafts", save), draftReceipt);
    assert.equal(draft.selection.text, "夜晚");
    await denied(post(origin, secondPath + "/drafts", { ...save, workId: draft.draft.id }), 403, "FORBIDDEN");
    const secondActivity = await result(get(origin, secondPath), activityDetail);
    await denied(post(origin, secondPath + "/submissions", {
      protocolVersion: 1, operationId: "submit", stepAttemptId: second.stepAttemptId,
      slotId: secondActivity.step.slotId, draft: draft.draft,
    }), 403, "FORBIDDEN");
    assert.equal((await result(get(origin, secondPath), activityDetail)).submission, null);
  } finally {
    await close(server);
  }
});

test("已发布版本固定，旧活动和重发沿用启动时的教学依赖", async t => {
  const databasePath = temporaryDatabasePath(t);
  const initial = createLearningServer({ databasePath, publication, sessions });
  const start = { protocolVersion: 1, operationId: "start-1", practiceId: publication.practice.id };
  let first: ReturnType<typeof startReceipt.parse>;
  try {
    first = await result(post(await listen(initial), "/api/activities", start), startReceipt);
  } finally {
    await close(initial);
  }

  const change = (definition: unknown) => createLearningServer({ databasePath, publication: definition, sessions });
  assert.throws(() => change({ ...publication, material: { ...publication.material, title: "覆盖原材料" } }), /已发布/);
  const material2 = { ...publication.material, version: 2, title: "新材料" };
  const practice2 = {
    ...publication.practice, version: 2, material: { id: material2.id, version: material2.version },
  };
  assert.throws(() => change({ material: material2, practice: { ...practice2, version: 1 } }), /已发布/);
  assert.throws(() => change({ material: material2, practice: publication.practice }), /引用的材料版本/);
  assert.throws(() => change({ material: { ...publication.material, id: "other" }, practice: publication.practice }), /引用的材料版本/);
  using stored = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(stored.prepare("SELECT version FROM materials").all().map(row => row.version), [1]);
  assert.deepEqual(stored.prepare("SELECT version FROM practices").all().map(row => row.version), [1]);

  const updated = change({ material: material2, practice: practice2 });
  try {
    const origin = await listen(updated);
    const old = await result(get(origin, `/api/activities/${first.activityId}`), activityDetail);
    assert.deepEqual(old.material, publication.material);
    assert.deepEqual(await result(post(origin, "/api/activities", start), startReceipt), first);
    const second = await result(post(origin, "/api/activities", { ...start, operationId: "start-2" }), startReceipt);
    const latest = await result(get(origin, `/api/activities/${second.activityId}`), activityDetail);
    assert.deepEqual(latest.material, material2);
  } finally {
    await close(updated);
  }
});

function temporaryDatabasePath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "test.sqlite");
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function post(origin: string, path: string, input: unknown, session = "first-session") {
  return fetch(origin + path, {
    method: "POST",
    headers: { cookie: `learning_session=${session}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

function get(origin: string, path: string, session = "first-session") {
  return fetch(origin + path, { headers: { cookie: `learning_session=${session}` } });
}

async function result<Output>(pending: Promise<Response>, schema: ZodType<Output>) {
  const response = await pending;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return schema.parse(JSON.parse(text));
}

async function denied(pending: Promise<Response>, status: number, code: string) {
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, { code });
}

function unfinishedRequest(endpoint: string, headers: Record<string, string>, body: string) {
  return new Promise<Response>((resolve, reject) => {
    const stream = request(endpoint, { method: "POST", headers: { ...headers, connection: "close" } }, response => {
      const bytes: Buffer[] = [];
      response.on("data", (chunk: Buffer) => bytes.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        stream.destroy();
        try {
          assert.ok(response.statusCode);
          const cache = response.headers["cache-control"];
          assert.equal(typeof cache, "string");
          resolve(new Response(Buffer.concat(bytes).toString("utf8"), {
            status: response.statusCode, headers: { "cache-control": String(cache) },
          }));
        } catch (error) {
          reject(error);
        }
      });
    });
    stream.on("error", reject);
    stream.setTimeout(3000, () => stream.destroy(new Error("未结束的请求未收到拒绝结果")));
    stream.write(body);
  });
}
