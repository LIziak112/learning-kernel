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

test("指定的验收组缺失时返回失败，其他通过的用例不能替代", (t) => {
  const root = fixture(t, {
    "tests/present.test.ts": "import { test } from 'node:test'; test('已交付组', () => {});",
  });
  const missing = execute(root, "--require", "tests/missing.test.ts");
  assert.equal(missing.status, 1);
  assert.match(missing.output, /缺少已交付验收组.*missing\.test\.ts/);
  const present = execute(root, "--require", "tests/present.test.ts");
  assert.equal(present.status, 0, present.output);
  assert.match(present.output, /真实用例 1/);
});

const releaseGroups = [
  "双端同时交卷", "交卷后重启", "同题连续改判", "撤权后重新读取",
  "声明对照 A", "声明对照 B", "声明对照 C", "浏览器链路",
];

function releaseFixture(groups: string[], skipped?: string) {
  return ["import { test } from 'node:test';", ...groups.map(group =>
    `${group === skipped ? "test.skip" : "test"}(${JSON.stringify(group + "｜一条实际用例")}, () => {});`,
  )].join("\n");
}

test("首版报告给出每个规定场景的实跑数，缺组时验收失败", t => {
  const root = fixture(t, { "tests/release.test.ts": releaseFixture(releaseGroups) });
  const complete = execute(root, "--first-release");
  assert.equal(complete.status, 0, complete.output);
  for (const group of releaseGroups) assert.ok(complete.output.includes(group + "　用例 1，通过 1"), complete.output);

  writeFileSync(join(root, "tests", "release.test.ts"), releaseFixture(releaseGroups.slice(0, -1)));
  const missing = execute(root, "--first-release");
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /浏览器链路　用例 0，通过 0/);
});

test("首版报告计入跳过发生的位置并拒绝通过", t => {
  const root = fixture(t, { "tests/release.test.ts": releaseFixture(releaseGroups, "声明对照 C") });
  const skipped = execute(root, "--first-release");
  assert.equal(skipped.status, 1, skipped.output);
  assert.match(skipped.output, /声明对照 C　用例 1，通过 0/);
});
