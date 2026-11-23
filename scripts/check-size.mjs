import { sourceFiles } from "./source-files.mjs";

const softLimit = 400;
const hardLimit = 1000;
const excludedDirectory = /(?:^|\/)(?:e2e|tests?|test-support|__tests__|fixtures|__fixtures__|__mocks__|__snapshots__|migrations|generated)\//;
const excludedFile = /\.(?:test|spec|gen|generated)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

function isSource(file) {
  return /\.[cm]?[jt]sx?$/.test(file)
    && !excludedDirectory.test(file)
    && !excludedFile.test(file)
    && !/^\.(?:codex|zcode)\/skills\//.test(file);
}

function check(staged) {
  let checked = 0;
  let oversized = 0;
  for (const [file, source] of sourceFiles(staged, isSource)) {
    const lines = source.split("\n");
    checked++;
    const count = lines.length - (lines.at(-1) === "" ? 1 : 0);
    if (count > hardLimit) {
      oversized++;
      console.error(`${file}: ${count} 行，超过 ${hardLimit} 行，按职责拆分后提交。`);
    } else if (count > softLimit) {
      console.warn(`${file}: ${count} 行，超过 ${softLimit} 行，继续增长前说明拆分方案。`);
    }
  }
  console.log(`受检 ${checked} 个源码文件，超过硬线 ${oversized} 个。`);
  return oversized === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--staged")) {
  console.error("用法：node scripts/check-size.mjs [--staged]");
  process.exitCode = 2;
} else {
  process.exitCode = check(args[0] === "--staged");
}
