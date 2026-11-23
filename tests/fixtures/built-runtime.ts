import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function buildRuntime() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  const output = mkdtempSync(join(target, "contrast-runtime-"));
  try {
    execFileSync(process.execPath, [join(root, "scripts", "build-runtime.mjs"), output], { cwd: root, stdio: "inherit" });
    const signature = hashRuntime(output);
    const server: typeof import("../../src/host/server.ts") = await import(pathToFileURL(join(output, "src", "host", "server.js")).href);
    const demo: typeof import("../../src/host/demo.ts") = await import(pathToFileURL(join(output, "src", "host", "demo.js")).href);
    console.log(`声明对照共用运行产物 SHA-256 ${signature}`);
    return {
      server: server.createLearningServer,
      demo: demo.createDemoServer,
      finish() {
        try {
          assert.equal(hashRuntime(output), signature, "A、B、C 使用的运行产物发生变化");
        } finally {
          rmSync(output, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function hashRuntime(output: string) {
  const digest = createHash("sha256");
  for (const name of globSync("**/*", { cwd: output }).sort()) {
    const path = join(output, name);
    if (statSync(path).isFile()) digest.update(name.replaceAll("\\", "/")).update("\0").update(readFileSync(path));
  }
  return digest.digest("hex");
}
