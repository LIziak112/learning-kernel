import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../scripts/check-size.mjs", import.meta.url));

function temporaryRepo(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kernel-size-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args]);
  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  function write(path: string, text: string) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  function check(...args: string[]) {
    const result = spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8" });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  }
  return { git, write, check };
}

test("工作区按实际行数检查未跟踪源码，显示超过软线的路径并拦截硬线", (t) => {
  const repo = temporaryRepo(t);
  const file = "src/中文 名称.ts";
  for (const [size, exitCode, warning] of [
    [400, 0, false], [401, 0, true], [1000, 0, true], [1001, 1, false],
  ] as const) {
    // 同时覆盖 CRLF 与最后一行没有换行符。
    repo.write(file, Array<string>(size).fill("// 数据").join("\r\n"));
    const result = repo.check();
    assert.equal(result.status, exitCode, result.output);
    assert.match(result.output, /受检 1 个源码文件/);
    assert.equal(result.output.includes("拆分"), warning || exitCode === 1, result.output);
    if (warning || exitCode === 1) assert.ok(result.output.includes(`${file}: ${size} 行`), result.output);
  }
});

test("提交门禁只读暂存版本，工作区门禁读取本地内容", (t) => {
  const repo = temporaryRepo(t);
  const file = "src/index.mts";
  repo.write(file, "// 超限\n".repeat(1001));
  repo.git("add", "--", file);
  repo.write(file, "// 本地已拆分\n");
  const stagedLarge = repo.check("--staged");
  assert.equal(stagedLarge.status, 1, stagedLarge.output);
  assert.match(stagedLarge.output, /src\/index\.mts: 1001 行/);
  assert.equal(repo.check().status, 0);
  repo.git("add", "--", file);
  repo.write(file, "// 本地尚未暂存\n".repeat(1001));
  assert.equal(repo.check("--staged").status, 0);
  assert.equal(repo.check().status, 1);
});

test("遵循 Git 忽略与仓库豁免，普通业务源码仍计入", (t) => {
  const repo = temporaryRepo(t);
  repo.write(".gitignore", "/artifacts/\n");
  repo.write("src/live.ts", "// 检查\n");
  for (const file of [
    "tests/helper.ts", "src/api.test.ts", "e2e/browser.ts", "src/fixtures/rows.ts",
    "src/types.d.ts", "src/db/migrations/001.ts", "src/generated/schema.ts", "src/rows.gen.ts",
    ".codex/skills/sample/helper.ts", "artifacts/ignore.ts",
  ]) repo.write(file, "// 样本\n".repeat(1001));
  const result = repo.check();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /受检 1 个源码文件/);
});
