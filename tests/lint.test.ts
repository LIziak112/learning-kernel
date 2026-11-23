import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../scripts/lint.mjs", import.meta.url));

function fixture(context: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "kernel-lint-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [command, ...args], { cwd, encoding: "utf8" });
    assert.ifError(result.error);
    return result;
  }
  return { cwd, git, run };
}

test("静态门禁区分语法与字面量，并按暂存版本判定", context => {
  const { cwd, git, run } = fixture(context);
  const file = join(cwd, "sample.test.ts");
  writeFileSync(file, ["// @generated", "/* @ts-ignore */", "/** 说明 */", "type Unsafe = any;", "test.only('聚焦', job);", "test('聚焦', { only: true }, job);"].join("\n"));
  git("add", "sample.test.ts");
  writeFileSync(file, ["#!/usr/bin/env node", "// SPDX-License-Identifier: MIT", "const url = 'https://example.org';", String.raw`const slash = /\/\//;`, "const label = `/* any */`;", "type Safe = unknown;", "test('正常', job);"].join("\n"));
  const staged = run("--staged");
  assert.equal(staged.status, 1);
  for (let line = 1; line <= 6; line++) assert.ok(staged.stderr.includes(`sample.test.ts:${line}:`), staged.stderr);
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);
  git("add", "sample.test.ts");
  writeFileSync(file, "// eslint-disable\n");
  assert.equal(run("--staged").status, 0);
  assert.equal(run().status, 1);
});

test("聚焦检查只作用于测试，许可证注释必须位于文件头且单行", context => {
  const { cwd, run } = fixture(context);
  writeFileSync(join(cwd, "business.ts"), "rules.test({ only: true });");
  writeFileSync(join(cwd, "sample.test.ts"), [
    "/* SPDX-License-Identifier: MIT",
    "*/",
    "test('不聚焦', { only: false }, job);",
    "test('动态键', { [mode]: true }, job);",
    "test['only']('聚焦', job);",
  ].join("\n"));
  writeFileSync(join(cwd, "helper.mjs"), "export const port = 3000; // SPDX-License-Identifier: MIT");
  const result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    result.stderr.trim().split(/\r?\n/).map(line => line.split(":").slice(0, 2).join(":")).sort(),
    ["helper.mjs:1", "sample.test.ts:1", "sample.test.ts:5"],
    result.stderr,
  );
});
