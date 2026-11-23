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
      const snapshot = "choice-snapshot-consumer.mts";
      cpSync(new URL("./fixtures/choice-snapshot-consumer.mts", import.meta.url), join(directory, snapshot));
      inputs.push(snapshot);
      for (const phase of ["write", "recover"]) {
        execFileSync(process.execPath, [snapshot, phase], { cwd: directory, stdio: "inherit" });
      }
      const bindings = "activity-binding-consumer.mts";
      cpSync(new URL("./fixtures/activity-binding-consumer.mts", import.meta.url), join(directory, bindings));
      inputs.push(bindings);
      execFileSync(process.execPath, [bindings], { cwd: directory, stdio: "inherit" });
      const amendmentBindings = "teacher-amendment-binding-consumer.mts";
      cpSync(new URL("./fixtures/teacher-amendment-binding-consumer.mts", import.meta.url), join(directory, amendmentBindings));
      inputs.push(amendmentBindings);
      execFileSync(process.execPath, [amendmentBindings], { cwd: directory, stdio: "inherit" });
      const prepare = "prepared-version-consumer.mts";
      cpSync(new URL("./fixtures/prepared-version-consumer.mts", import.meta.url), join(directory, prepare));
      inputs.push(prepare);
      for (const phase of ["open", "recover"]) {
        execFileSync(process.execPath, [prepare, host, phase], { cwd: directory, stdio: "inherit" });
      }
      if (host === "library-club") {
        const run = promisify(execFile);
        for (const contender of ["save", "confirm"]) {
          execFileSync(process.execPath, [snapshot, "race-prepare", contender], { cwd: directory, stdio: "inherit" });
          const outcomes = await Promise.allSettled(["race-revise", "race-contend"].map(phase =>
            run(process.execPath, [snapshot, phase, contender], { cwd: directory })));
          const [revision, contenderStatus] = outcomes.map(result => {
            if (result.status === "rejected") throw result.reason;
            return result.value.stdout.trim();
          });
          const cancelled = contender === "save" ? "ANSWER_REVISION_CONFLICT" : "ALREADY_SUBMITTED";
          assert.ok((revision === "revised" && contenderStatus === "QUESTION_REVISION_STALE")
            || (revision === cancelled && contenderStatus === "accepted"));
          execFileSync(process.execPath, [snapshot, "race-recover", contender, revision], { cwd: directory, stdio: "inherit" });
        }
        execFileSync(process.execPath, [prepare, host, "race-prepare"], { cwd: directory, stdio: "inherit" });
        const competed = await Promise.allSettled(["race-change", "race-save"].map(phase =>
          run(process.execPath, [prepare, host, phase], { cwd: directory })));
        const [changed, saved] = competed.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value.stdout.trim();
        });
        assert.ok((changed === "changed" && saved === "stale") || (changed === "kept" && saved === "saved"));
        execFileSync(process.execPath, [prepare, host, "race-recover", changed], { cwd: directory, stdio: "inherit" });
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
        cpSync(new URL("./fixtures/frozen-choice.json", import.meta.url), join(directory, "frozen-choice.json"));
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
        const responses = "response-confirmation-consumer.mts";
        cpSync(new URL("./fixtures/response-confirmation-consumer.mts", import.meta.url), join(directory, responses));
        inputs.push(responses);
        for (const phase of ["write", "recover", "read-stored"]) {
          execFileSync(process.execPath, [responses, phase], { cwd: directory, stdio: "inherit" });
        }
        const indexes = "index-response-confirmation-consumer.mts";
        cpSync(new URL("./fixtures/index-response-confirmation-consumer.mts", import.meta.url), join(directory, indexes));
        inputs.push(indexes);
        for (const phase of ["write", "recover", "read-stored"]) {
          execFileSync(process.execPath, [indexes, phase], { cwd: directory, stdio: "inherit" });
        }
        const delivery = "question-delivery-consumer.mts";
        cpSync(new URL("./fixtures/question-delivery-consumer.mts", import.meta.url), join(directory, delivery));
        inputs.push(delivery);
        execFileSync(process.execPath, [delivery, "write"], { cwd: directory, stdio: "inherit" });
        const [question, finish] = await Promise.all([
          run(process.execPath, [delivery, "race-question"], { cwd: directory }),
          run(process.execPath, [delivery, "race-finish"], { cwd: directory }),
        ]);
        const status = question.stdout.trim();
        assert.ok(status === "confirmed" || status === "closed");
        assert.equal(finish.stdout.trim(), "finished");
        for (const phase of ["recover", "read-stored"]) {
          execFileSync(process.execPath, [delivery, phase, status], { cwd: directory, stdio: "inherit" });
        }
        const titledText = "titled-text-consumer.mts";
        cpSync(new URL("./fixtures/titled-text-consumer.mts", import.meta.url), join(directory, titledText));
        inputs.push(titledText);
        for (const phase of ["write", "recover", "read-stored"]) {
          execFileSync(process.execPath, [titledText, phase], { cwd: directory, stdio: "inherit" });
        }
        const deliveryAssessment = "question-delivery-assessment-consumer.mts";
        cpSync(new URL("./fixtures/question-delivery-assessment-consumer.mts", import.meta.url), join(directory, deliveryAssessment));
        inputs.push(deliveryAssessment);
        for (const phase of ["write", "recover"]) {
          execFileSync(process.execPath, [deliveryAssessment, phase], { cwd: directory, stdio: "inherit" });
        }
        const deliveryVerdict = "question-delivery-verdict-consumer.mts";
        cpSync(new URL("./fixtures/question-delivery-verdict-consumer.mts", import.meta.url), join(directory, deliveryVerdict));
        inputs.push(deliveryVerdict);
        const verdictOperations = ["mark-a", "mark-b"];
        const verdictRaces = await Promise.allSettled(verdictOperations.map(operation =>
          run(process.execPath, [deliveryVerdict, "race", operation], { cwd: directory })));
        const verdictStatuses = verdictRaces.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value.stdout.trim();
        });
        assert.deepEqual(verdictStatuses.toSorted(), ["VERDICT_CONFLICT", "committed"]);
        const winningVerdict = verdictOperations[verdictStatuses.indexOf("committed")];
        assert.ok(winningVerdict);
        for (const phase of ["clear", "recover"]) {
          execFileSync(process.execPath, [deliveryVerdict, phase, winningVerdict], { cwd: directory, stdio: "inherit" });
        }
        const answerRule = "question-answer-rule-consumer.mts";
        cpSync(new URL("./fixtures/question-answer-rule-consumer.mts", import.meta.url), join(directory, answerRule));
        inputs.push(answerRule);
        for (const phase of ["write", "recover"]) {
          execFileSync(process.execPath, [answerRule, phase], { cwd: directory, stdio: "inherit" });
        }
        const materialPositions = "material-positions-consumer.mts";
        cpSync(new URL("./fixtures/material-positions-consumer.mts", import.meta.url), join(directory, materialPositions));
        inputs.push(materialPositions);
        execFileSync(process.execPath, [materialPositions, "write"], { cwd: directory, stdio: "inherit" });
        const materialReopens = await Promise.allSettled([0, 1].map(() =>
          run(process.execPath, [materialPositions, "recover"], { cwd: directory })));
        for (const reopened of materialReopens) {
          if (reopened.status === "rejected") throw reopened.reason;
        }
        const timing = "choice-draft-activity-consumer.mts";
        cpSync(new URL("./fixtures/choice-draft-activity-consumer.mts", import.meta.url), join(directory, timing));
        inputs.push(timing);
        assert.throws(() => execFileSync(process.execPath, [timing, "write"], { cwd: directory, stdio: "pipe" }), { status: 49 });
        execFileSync(process.execPath, [timing, "recover"], { cwd: directory, stdio: "inherit" });
        const current = "current-choice-draft-consumer.mts";
        cpSync(new URL("./fixtures/current-choice-draft-consumer.mts", import.meta.url), join(directory, current));
        inputs.push(current);
        for (const phase of ["write", "recover"]) {
          execFileSync(process.execPath, [current, phase], { cwd: directory, stdio: "inherit" });
        }
        execFileSync(process.execPath, [current, "race-prepare"], { cwd: directory, stdio: "inherit" });
        const candidates = ["race-one", "race-two"];
        const raced = await Promise.allSettled(candidates.map(phase => run(process.execPath, [current, phase], { cwd: directory })));
        const outcomes = raced.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value.stdout.trim();
        });
        assert.equal(outcomes.filter(outcome => outcome === "lost").length, 1);
        const latestWinner = outcomes.find(outcome => outcome !== "lost");
        assert.ok(latestWinner === "race-one" || latestWinner === "race-two");
        execFileSync(process.execPath, [current, "race-recover", latestWinner], { cwd: directory, stdio: "inherit" });
        const amendment = "choice-amendment-consumer.mts";
        cpSync(new URL("./fixtures/choice-amendment-consumer.mts", import.meta.url), join(directory, amendment));
        inputs.push(amendment);
        for (const phase of ["write", "recover"]) {
          execFileSync(process.execPath, [amendment, phase], { cwd: directory, stdio: "inherit" });
        }
        execFileSync(process.execPath, [amendment, "race-prepare"], { cwd: directory, stdio: "inherit" });
        const edited = await Promise.allSettled(["race-amend", "race-confirm"].map(phase =>
          run(process.execPath, [amendment, phase], { cwd: directory })));
        const [amendmentStatus, confirmationStatus] = edited.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value.stdout.trim();
        });
        assert.ok((amendmentStatus === "amended" && confirmationStatus === "ANSWER_REVISION_CONFLICT")
          || (amendmentStatus === "ALREADY_SUBMITTED" && confirmationStatus === "confirmed"));
        execFileSync(process.execPath, [amendment, "race-recover", amendmentStatus], { cwd: directory, stdio: "inherit" });
      }
      const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
      execFileSync(process.execPath, [compiler, "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
        "--target", "ES2024", "--module", "NodeNext", "--types", "node", "--typeRoots", join(root, "node_modules/@types"), ...inputs], {
        cwd: directory, stdio: "inherit",
      });
    });
  }
});
