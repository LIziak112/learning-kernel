import { globSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { run } from "node:test";
import { lcov, spec } from "node:test/reporters";
import { parseArgs } from "node:util";

const { values: { coverage, require: required, "first-release": firstRelease } } = parseArgs({
  options: {
    coverage: { type: "boolean", default: false },
    require: { type: "string", multiple: true, default: [] },
    "first-release": { type: "boolean", default: false },
  },
});
const report = resolve("coverage/lcov.info");
if (coverage) rmSync(report, { force: true });

const files = globSync("tests/**/*.test.ts").sort();
if (files.length === 0) {
  console.error("未发现测试文件：tests/**/*.test.ts");
  process.exitCode = 1;
} else {
  const discovered = new Set(files.map(file => resolve(file)));
  const absent = required.filter(file => !discovered.has(resolve(file)));
  for (const file of absent) console.error(`缺少已交付验收组：${file}`);
  if (absent.length > 0) process.exitCode = 1;
  else await verify(files);
}

async function verify(files) {
  const missing = new Set(files.map(file => resolve(file)));
  const stream = run({ files, coverage, coverageIncludeGlobs: ["src/**"] });
  let successful = false;
  let actualTests = 0;
  let coverageEvent;
  let incomplete = false;
  const release = firstRelease ? releaseReport() : undefined;

  stream.on("data", event => {
    release?.record(event);
    if (event.type === "test:coverage") coverageEvent = event;
    if (event.type !== "test:summary") return;
    const { file, counts, success } = event.data;
    if (!file) {
      successful = success;
      return;
    }
    if (counts.tests > 0) missing.delete(resolve(file));
    actualTests += counts.tests;
    incomplete ||= counts.skipped > 0 || counts.todo > 0 || counts.cancelled > 0;
  });
  for await (const chunk of stream.compose(spec)) process.stdout.write(chunk);
  console.log(`真实用例 ${actualTests}`);
  for (const file of missing) console.error(`未执行真实用例：${relative(process.cwd(), file)}`);
  const releasePassed = release?.print() ?? true;
  if (!successful || incomplete || missing.size !== 0 || !releasePassed) {
    process.exitCode = 1;
    return;
  }
  if (coverage) await saveCoverage(coverageEvent);
}

function releaseReport() {
  const groups = new Map([
    "双端同时交卷", "交卷后重启", "同题连续改判", "撤权后重新读取",
    "声明对照 A", "声明对照 B", "声明对照 C", "浏览器链路",
  ].map(name => [name, { total: 0, passed: 0 }]));
  return {
    record({ type, data }) {
      if (type !== "test:pass" && type !== "test:fail") return;
      if (data.details.type !== "test") return;
      const [name, behavior] = data.name.split("｜", 2);
      const group = groups.get(name);
      if (!group || !behavior) return;
      group.total++;
      if (type === "test:pass" && !data.skip && !data.todo) group.passed++;
    },
    print() {
      for (const [name, { total, passed }] of groups) {
        console.log(`${name}　用例 ${total}，通过 ${passed}`);
      }
      return [...groups.values()].every(({ total, passed }) => total > 0 && passed === total);
    },
  };
}

async function saveCoverage(event) {
  if (!event?.data.summary.files.length) {
    throw new Error("覆盖率模式未记录 src 下的源码");
  }
  let content = "";
  for await (const chunk of Readable.from([event]).compose(lcov)) content += chunk;
  content = content.replace(/^SF:.*$/gm, line => line.replaceAll("\\", "/"));
  mkdirSync("coverage", { recursive: true });
  writeFileSync(report, content);
}
