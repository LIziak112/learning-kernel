import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import project from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const acceptance = join(root, "target", "acceptance");

function run(executable, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, env, encoding: "utf8", windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`命令失败 ${args.join(" ")}${result.signal ? " · " + result.signal : ""}`);
  }
  return result.stdout?.trim();
}

function runPnpm(args, options) {
  const launcher = process.env.npm_execpath;
  if (!launcher) throw new Error("请用 pnpm run accept:fresh 启动验收");
  return /\.[cm]?js$/i.test(launcher)
    ? run(process.execPath, [launcher, ...args], options)
    : run(launcher, args, options);
}

function requireCleanCheckout() {
  if (run("git", ["status", "--porcelain"], { capture: true })) {
    throw new Error("验收需要干净的 Git 检出");
  }
}

function accept() {
  requireCleanCheckout();
  const expectedNode = readFileSync(join(root, ".node-version"), "utf8").trim();
  const expectedPnpm = project.packageManager.slice("pnpm@".length);
  const actualPnpm = runPnpm(["--version"], { capture: true });
  if (process.versions.node !== expectedNode || actualPnpm !== expectedPnpm) {
    throw new Error(`需要 Node ${expectedNode} 和 pnpm ${expectedPnpm}，实际为 Node ${process.versions.node} 和 pnpm ${actualPnpm}`);
  }
  const revision = run("git", ["rev-parse", "HEAD"], { capture: true });
  console.log(`Git 修订 ${revision}`);
  const store = join(acceptance, "pnpm-store");
  const env = {
    ...process.env,
    PNPM_CONFIG_CACHE_DIR: join(acceptance, "pnpm-cache"),
    PNPM_CONFIG_STORE_DIR: store,
    PLAYWRIGHT_BROWSERS_PATH: join(acceptance, "chromium"),
  };
  runPnpm(["install", "--frozen-lockfile", "--store-dir", store], { env });
  runPnpm(["exec", "playwright", "install", "--only-shell", "chromium"], { env });
  runPnpm(["run", "verify", "--first-release"], { env });
  requireCleanCheckout();
}

try {
  accept();
} catch (error) {
  console.error(error.message);
  process.exitCode ??= 1;
}
