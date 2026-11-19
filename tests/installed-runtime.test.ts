import { strict as assert } from "node:assert";
import { execFile, execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import project from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

function pack(directory: string) {
  return execSync("npm pack --offline --ignore-scripts --cache .npm-cache --update-notifier=false --silent", {
    cwd: directory, encoding: "utf8", windowsHide: true,
  }).trim();
}

test("独立宿主共用安装包，按主体开卷并在新进程恢复同一冻结活动", async t => {
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  const output = mkdtempSync(join(target, "installed-runtime-"));
  const isolated = mkdtempSync(join(tmpdir(), "learning-hosts-"));
  t.after(() => {
    rmSync(output, { recursive: true, force: true });
    rmSync(isolated, { recursive: true, force: true });
  });
  execFileSync(process.execPath, [join(root, "scripts", "build-runtime.mjs"), output], { cwd: root });
  const runtimePackage = pack(output);
  assert.equal(runtimePackage, `${project.name}-${project.version}.tgz`);
  const dependency = join(isolated, "dependency");
  cpSync(realpathSync(join(root, "node_modules/zod")), dependency, { recursive: true });
  const zodPackage = pack(dependency);
  assert.equal(zodPackage, `zod-${project.dependencies.zod}.tgz`);

  for (const host of ["after-school", "library-club"]) {
    await t.test(host, async () => {
      const directory = join(isolated, host);
      mkdirSync(directory);
      cpSync(join(output, runtimePackage), join(directory, runtimePackage));
      cpSync(join(dependency, zodPackage), join(directory, zodPackage));
      writeFileSync(join(directory, "package.json"), JSON.stringify({
        name: host, private: true, type: "module", dependencies: {
          [project.name]: `file:./${runtimePackage}`, zod: `file:./${zodPackage}`,
        },
      }));
      execSync("npm install --offline --ignore-scripts --no-audit --no-fund --cache .npm-cache --update-notifier=false", {
        cwd: directory, windowsHide: true,
      });
      assert.equal(existsSync(join(directory, "node_modules", project.name, "src/host")), false);
      cpSync(new URL("./fixtures/host-package-consumer.mts", import.meta.url), join(directory, "consumer.mts"));
      for (const phase of ["start", "recover"]) {
        execFileSync(process.execPath, ["consumer.mts", host, phase], { cwd: directory, stdio: "inherit" });
      }
      if (host === "library-club") {
        const run = promisify(execFile);
        const writes = await Promise.allSettled(["parallel-q1", "parallel-q2"].map(phase =>
          run(process.execPath, ["consumer.mts", host, phase], { cwd: directory })));
        for (const result of writes) if (result.status === "rejected") throw result.reason;
        execFileSync(process.execPath, ["consumer.mts", host, "parallel-recover"], { cwd: directory, stdio: "inherit" });
      }
      const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
      execFileSync(process.execPath, [compiler, "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
        "--target", "ES2024", "--module", "NodeNext", "--types", "node", "--typeRoots", join(root, "node_modules/@types"), "consumer.mts"], {
        cwd: directory, stdio: "inherit",
      });
    });
  }
});
