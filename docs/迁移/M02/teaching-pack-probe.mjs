import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempDisposableSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const revision = "49a3fb0721c16cf9a2ba4f3d1f4fe89c471e3908";
const checkout = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), revision);
const serverDir = join(checkout, "apps", "server");
const serverRequire = createRequire(join(serverDir, "package.json"));
const { createApp } = await import(pathToFileURL(join(serverDir, "src", "app.ts")));
const { createTestDb } = await import(pathToFileURL(join(serverDir, "src", "db", "test-utils.ts")));
const { Client } = await import(pathToFileURL(serverRequire.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(serverRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")));
const { ZipArchive } = await import(pathToFileURL(serverRequire.resolve("archiver")));

const missing = 'teachingPack: {name: "合成教学包", directives: [future-box], validators: [future-judge]}';
const valid = 'teachingPack: {name: "合成教学包", directives: [steps], validators: [judge]}';

function document(unit, declaration = "", image = "") {
  return `---
kind: mixed
unit: ${unit}
${declaration}
---

# ${unit} 的讲义

普通讲义文字。

::::question{type=judge difficulty=1 id=${unit}-q1}
$1+1=2$。[[正确]]

:::future-box
降级后仍能读到的正文。
:::

${image}
::::
`;
}

function diagnostics(issues) {
  return issues.map(({ level, code }) => `${level}:${code}`).sort();
}

const unknownBody = ["warning:UNKNOWN_DIRECTIVE"];
const dependencyErrors = [
  "error:DIRECTIVE_REF_NOT_FOUND",
  "error:VALIDATOR_REF_NOT_FOUND",
];
const unavailableDependencies = [...dependencyErrors, ...unknownBody];

async function openFixture(t) {
  const data = mkdtempDisposableSync(join(tmpdir(), "m02-pack-"));
  const db = createTestDb();
  t.after(() => {
    db.$client.close();
    data.remove();
  });
  const app = createApp({
    db,
    dataDir: data.path,
    isProduction: false,
    logger: serverRequire("pino")({ enabled: false }),
    publicUrl: "http://localhost",
  });
  async function post(path, body, cookie) {
    const headers = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  }
  const setup = await post("/api/public/teacher/setup", { loginName: "teacher", password: "synthetic-m02-pass" });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.getSetCookie().find((line) => line.startsWith("tutor_session="))?.split(";")[0];
  assert.ok(cookie);

  return {
    app,
    cookie,
    dataDir: data.path,
    post: (path, body) => post(`/api/teacher/import/${path}`, body, cookie),
    rows: (table) => db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  };
}

function contentSnapshot(fixture) {
  return ["lectures", "units", "questions", "library_folders", "course_items", "imports"]
    .map((table) => fixture.rows(table));
}

async function readResponse(response, status, ok) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.ok, ok);
  return body;
}

test("未注册的显式依赖经单份及批量预览诊断，直接提交 422 且无半包", async (t) => {
  const fixture = await openFixture(t);
  const before = contentSnapshot(fixture);
  const markdown = document("m02-invalid", missing);
  const input = { markdown, filename: "invalid.md" };

  const rejected = await readResponse(await fixture.post("commit", { ...input, folderName: "未创建目录" }), 422, false);
  assert.equal(rejected.error, "LINT_ERROR");
  assert.deepEqual(diagnostics(rejected._issues), dependencyErrors);
  assert.deepEqual(contentSnapshot(fixture), before);

  const { data: preview } = await readResponse(await fixture.post("preview", input), 200, true);
  assert.deepEqual(diagnostics(preview.issues), unavailableDependencies);
  assert.equal(preview.summary.questionCount, 1);
  assert.equal(preview.summary.lectureCount, 1);

  const { data: batch } = await readResponse(await fixture.post("preview-batch", {
    autoFolderBySubdir: true,
    files: [
      { markdown, path: "同批/invalid.md" },
      { markdown: document("m02-plain"), path: "同批/plain.md" },
    ],
  }), 200, true);
  assert.deepEqual(batch.files.map(({ path, hasError, preview }) => [path, hasError, diagnostics(preview.issues)]), [
    ["同批/invalid.md", true, unavailableDependencies],
    ["同批/plain.md", false, unknownBody],
  ]);
  assert.deepEqual(contentSnapshot(fixture), before);
});

test("普通正文未知指令有 warning 可导入，合法声明保留且失败重导不覆写", async (t) => {
  const fixture = await openFixture(t);
  const unit = "m02-valid";
  const filename = "content.md";
  const plain = document(unit);
  const { data: preview } = await readResponse(await fixture.post("preview", { filename, markdown: plain }), 200, true);
  assert.deepEqual(diagnostics(preview.issues), unknownBody);
  const { data: imported } = await readResponse(await fixture.post("commit", { filename, markdown: plain }), 200, true);
  assert.deepEqual(imported.questions, { inserted: 1, updated: 0 });
  assert.equal(fixture.rows("units")[0].teaching_pack_json, null);
  assert.match(fixture.rows("questions")[0].stem_md, /降级后仍能读到的正文/);

  const markdown = document(unit, valid);
  const { data: labeled } = await readResponse(await fixture.post("preview", { filename, markdown }), 200, true);
  assert.deepEqual(diagnostics(labeled.issues), unknownBody);
  const { data: updated } = await readResponse(await fixture.post("commit", { filename, markdown }), 200, true);
  assert.deepEqual(updated.questions, { inserted: 0, updated: 1 });
  const declaration = { formatVersion: 1, name: "合成教学包", version: "1", directives: ["steps"], validators: ["judge"] };
  for (const table of ["lectures", "units"]) {
    const rows = fixture.rows(table);
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].teaching_pack_json), declaration);
  }
  assert.equal(fixture.rows("imports").length, 2);
  const before = contentSnapshot(fixture);
  const { error } = await readResponse(await fixture.post("commit", {
    filename,
    markdown: document(unit, missing).replace("普通讲义文字。", "不得覆盖的新版。"),
  }), 422, false);
  assert.equal(error, "LINT_ERROR");
  assert.deepEqual(contentSnapshot(fixture), before);
});

test("MCP Markdown 和 ZIP 都拒绝该内容，ZIP 确认的随行图已独立落盘", async (t) => {
  const fixture = await openFixture(t);
  const tokenResponse = await fixture.app.request("/api/teacher/api-token", {
    method: "POST",
    headers: { cookie: fixture.cookie },
  });
  const { data: { token } } = await readResponse(tokenResponse, 200, true);
  const client = new Client({ name: "m02-pack-probe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => fixture.app.request(new URL(String(url)).pathname, init),
  });
  await client.connect(transport);
  t.after(() => client.close());

  async function invoke(name, args, isError = false) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(Boolean(response.isError), isError, JSON.stringify(response));
    return JSON.parse(response.content.find(({ type }) => type === "text").text);
  }

  const before = contentSnapshot(fixture);
  const markdown = document("m02-mcp", missing);
  const args = { markdown, filename: "mcp.md" };
  const linted = await invoke("lint_markdown", args);
  assert.deepEqual(diagnostics(linted.issues), unavailableDependencies);
  const dryRun = await invoke("import_markdown", args);
  assert.equal(dryRun.confirmed, false);
  assert.deepEqual(diagnostics(dryRun.preview.issues), unavailableDependencies);
  const error = await invoke("import_markdown", { ...args, confirm: true }, true);
  assert.equal(error.error, "LINT_ERROR");
  assert.deepEqual(diagnostics(error._issues), dependencyErrors);
  assert.deepEqual(contentSnapshot(fixture), before);

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const zip = new ZipArchive();
  zip.append(document("m02-zip", missing, '::image{src="img/sample.png"}'), { name: "package.md" });
  zip.append(png, { name: "img/sample.png" });
  const chunks = [];
  const zipBytes = (async () => {
    for await (const chunk of zip) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  await zip.finalize();
  const zipArgs = { dataBase64: (await zipBytes).toString("base64") };
  const preview = await invoke("import_zip", zipArgs);
  assert.equal(preview.confirmed, false);
  assert.equal(preview.files.length, 1);
  assert.deepEqual(diagnostics(preview.files[0].issues), [
    ...dependencyErrors,
    "warning:IMAGE_SRC_NOT_BLOBS",
    ...unknownBody,
  ]);
  assert.equal(preview.images.uploadCount, 1);
  assert.equal(existsSync(join(fixture.dataDir, "blobs", "media")), false);
  assert.deepEqual(contentSnapshot(fixture), before);

  const result = await invoke("import_zip", { ...zipArgs, confirm: true });
  assert.equal(result.confirmed, true);
  assert.equal(result.files.length, 1);
  const [file] = result.files;
  assert.equal(file.path, "package.md");
  assert.equal(file.ok, false);
  assert.equal(file.error.code, "LINT_ERROR");
  assert.deepEqual(diagnostics(file.error._issues), dependencyErrors);
  assert.deepEqual(contentSnapshot(fixture), before);
  assert.equal(result.images.uploaded, 1);
  const [image] = result.images.results;
  assert.match(image.src, /^blobs\/media\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(readFileSync(join(fixture.dataDir, image.src)), png);
});
