import { globSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { run } from "node:test";
import { lcov, spec } from "node:test/reporters";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--coverage")) {
  throw new Error("用法：node scripts/run-tests.mjs [--coverage]");
}
const coverage = args.includes("--coverage");
const report = resolve("coverage/lcov.info");
if (coverage) rmSync(report, { force: true });

const files = globSync("tests/**/*.test.ts").sort();
if (files.length === 0) {
  console.error("未发现测试文件：tests/**/*.test.ts");
  process.exitCode = 1;
} else {
  await verify(files);
}

async function verify(files) {
  const missing = new Set(files.map(file => resolve(file)));
  const stream = run({ files, coverage, coverageIncludeGlobs: ["src/**"] });
  let successful = false;
  let actualTests = 0;
  let coverageEvent;
  let incomplete = false;

  stream.on("data", event => {
    if (event.type === "test:coverage") coverageEvent = event;
    if (event.type !== "test:summary") return;
    const { file, counts, success } = event.data;
    if (!file) {
      successful = success;
      return;
    }
    // 空文件也可能被 Node 汇总成一个成功项；按文件读取实际登记的用例数。
    if (counts.tests > 0) missing.delete(resolve(file));
    actualTests += counts.tests;
    incomplete ||= counts.skipped > 0 || counts.todo > 0 || counts.cancelled > 0;
  });
  for await (const chunk of stream.compose(spec)) process.stdout.write(chunk);
  console.log(`真实用例 ${actualTests}`);
  for (const file of missing) console.error(`未执行真实用例：${relative(process.cwd(), file)}`);
  if (!successful || incomplete || missing.size !== 0) {
    process.exitCode = 1;
    return;
  }
  if (coverage) await saveCoverage(coverageEvent);
}

async function saveCoverage(event) {
  if (!event?.data.summary.files.length) {
    throw new Error("覆盖率模式未记录 src 下的源码");
  }
  let content = "";
  for await (const chunk of Readable.from([event]).compose(lcov)) content += chunk;
  // 统一源码路径，使 Windows 和 Linux 产生的 LCOV 都能供指标工具复用。
  content = content.replace(/^SF:.*$/gm, line => line.replaceAll("\\", "/"));
  mkdirSync("coverage", { recursive: true });
  writeFileSync(report, content);
}
