import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

function fixture(t: TestContext, files: Record<string, string>) {
  const parent = resolve(process.cwd());
  const root = mkdtempSync(join(parent, ".test-runner-"));
  t.after(() => {
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith(".test-runner-"));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "tests"));
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function execute(root: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("验收发现嵌套文件并将真实业务源码输出到 LCOV", (t) => {
  const root = fixture(t, {
    "src/math.ts": "export function twice(n: number) { return n * 2; }",
    "tests/deep/math.test.ts": [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { twice } from '../../src/math.ts';",
      "test('double', () => assert.equal(twice(3), 6));",
      "test('zero', () => assert.equal(twice(0), 0));",
    ].join("\n"),
  });
  const result = execute(root, "--coverage");
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /真实用例 2/);
  const report = readFileSync(join(root, "coverage/lcov.info"), "utf8");
  assert.match(report, /^SF:src\/math\.ts$/m);
  assert.match(report, /^DA:\d+,[1-9]\d*$/m);
  assert.doesNotMatch(report, /^SF:.*\.test\.ts/m);
});

test("空测试目录和仅占位的测试文件都不能通过验收", (t) => {
  const root = fixture(t, {});
  const none = execute(root);
  assert.equal(none.status, 1);
  assert.match(none.output, /未发现测试文件/);
  writeFileSync(join(root, "tests", "empty.test.ts"), "// 等待添加用例\n");
  writeFileSync(join(root, "tests", "valid.test.ts"),
    "import { test } from 'node:test'; test('已登记', () => {});");
  const empty = execute(root);
  assert.equal(empty.status, 1);
  assert.match(empty.output, /未执行真实用例.*empty\.test\.ts/);
});

test("失败、跳过和待办用例都会令验收失败", (t) => {
  const root = fixture(t, {});
  for (const body of [
    "test('失败样本', () => { throw new Error('失败样本'); });",
    "test.skip('跳过样本', () => {});",
    "test.todo('待办样本');",
  ]) {
    writeFileSync(join(root, "tests", "sample.test.ts"), "import { test } from 'node:test';\n" + body);
    const result = execute(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /真实用例 1/);
  }
});
