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
      const inputs = ["consumer.mts"];
      if (host === "library-club") {
        const run = promisify(execFile);
        const writes = await Promise.allSettled(["parallel-q1", "parallel-q2"].map(phase =>
          run(process.execPath, ["consumer.mts", host, phase], { cwd: directory })));
        for (const result of writes) if (result.status === "rejected") throw result.reason;
        execFileSync(process.execPath, ["consumer.mts", host, "parallel-recover"], { cwd: directory, stdio: "inherit" });
        const confirmation = "choice-confirmation-consumer.mts";
        cpSync(new URL("./fixtures/choice-confirmation-consumer.mts", import.meta.url), join(directory, confirmation));
        inputs.push(confirmation);
        const operations = ["confirm-a", "confirm-b"];
        const attempted = await Promise.allSettled(operations.map(operation =>
          run(process.execPath, [confirmation, "race", operation], { cwd: directory })));
        const statuses = attempted.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value.stdout.trim();
        });
        assert.deepEqual(statuses.toSorted(), ["closed", "committed"]);
        const winner = operations[statuses.indexOf("committed")];
        assert.ok(winner);
        execFileSync(process.execPath, [confirmation, "recover", winner], { cwd: directory, stdio: "inherit" });
        const unversioned = "unversioned-choice-consumer.mts";
        cpSync(new URL("./fixtures/unversioned-choice-consumer.mts", import.meta.url), join(directory, unversioned));
        inputs.push(unversioned);
        execFileSync(process.execPath, [unversioned, "init"], { cwd: directory, stdio: "inherit" });
        const competing = await Promise.allSettled(["legacy", "modern"].map(phase =>
          run(process.execPath, [unversioned, phase], { cwd: directory })));
        const [legacy, modern] = competing.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value.stdout.trim();
        });
        assert.ok((legacy === "wrote" && modern === "3") || (legacy === "stopped" && modern === "2"));
        execFileSync(process.execPath, [unversioned, "recover", modern], { cwd: directory, stdio: "inherit" });
        const scoring = "choice-evaluator-consumer.mts";
        cpSync(new URL("./fixtures/choice-evaluator-consumer.mts", import.meta.url), join(directory, scoring));
        cpSync(new URL("../docs/迁移/M04/P0-冻结单选.json", import.meta.url), join(directory, "frozen-choice.json"));
        inputs.push(scoring);
        execFileSync(process.execPath, [scoring, "init"], { cwd: directory, stdio: "inherit" });
        assert.throws(() => execFileSync(process.execPath, [scoring, "crash"], { cwd: directory }), { status: 47 });
        execFileSync(process.execPath, [scoring, "wrong-version"], { cwd: directory, stdio: "inherit" });
        const evaluations = await Promise.allSettled([0, 1].map(() => run(process.execPath, [scoring, "recover"], { cwd: directory })));
        const evaluated = evaluations.map(result => {
          if (result.status === "rejected") throw result.reason;
          return Number(result.value.stdout.trim());
        });
        assert.equal(evaluated.reduce((sum, count) => sum + count, 0), 6);
        const timing = "choice-draft-activity-consumer.mts";
        cpSync(new URL("./fixtures/choice-draft-activity-consumer.mts", import.meta.url), join(directory, timing));
        inputs.push(timing);
        assert.throws(() => execFileSync(process.execPath, [timing, "write"], { cwd: directory, stdio: "pipe" }), { status: 49 });
        execFileSync(process.execPath, [timing, "recover"], { cwd: directory, stdio: "inherit" });
      }
      const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
      execFileSync(process.execPath, [compiler, "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
        "--target", "ES2024", "--module", "NodeNext", "--types", "node", "--typeRoots", join(root, "node_modules/@types"), ...inputs], {
        cwd: directory, stdio: "inherit",
      });
    });
  }
});
