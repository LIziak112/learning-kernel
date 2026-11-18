import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const softLimit = 400;
const hardLimit = 1000;
const excludedDirectory = /(?:^|\/)(?:e2e|tests?|test-support|__tests__|fixtures|__fixtures__|__mocks__|__snapshots__|migrations|generated)\//;
const excludedFile = /\.(?:test|spec|gen|generated)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const generatedHeader = /^\s*(?:\/\/|\/\*+|\*)\s*(?:@generated\b|AUTO-GENERATED\b|自动生成)/m;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function isSource(file) {
  return /\.[cm]?[jt]sx?$/.test(file)
    && !excludedDirectory.test(file)
    && !excludedFile.test(file)
    && !/^\.(?:codex|zcode)\/skills\//.test(file);
}

function workingCopy(root, file) {
  const path = join(root, file);
  // Git 也会列出尚未暂存的删除；符号链接本身没有源码行。
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  return readFileSync(path, "utf8");
}

function check(staged) {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trimEnd();
  const list = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const files = new Set(git(list, root).split("\0").filter(isSource));
  let checked = 0;
  let oversized = 0;
  for (const file of files) {
    const source = staged ? git(["show", `:${file}`], root) : workingCopy(root, file);
    if (source === null) continue;
    const lines = source.split("\n");
    if (generatedHeader.test(lines.slice(0, 5).join("\n"))) continue;
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
