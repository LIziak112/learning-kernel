import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { defineResponseType, LearningError } from "../../../src/server.ts";
import type { EvaluatorRegistration, ReviewScope } from "../../../src/server.ts";
import { scenarioDatabase } from "../online-reading.ts";
import { evaluatorRef, openRuntime, reviewer, student } from "./delivery.ts";
import type { ContractQuestion, Runtime } from "./delivery.ts";

const stubKey = z.strictObject({ acceptedToken: z.string().min(1) });

export const stubResponse = defineResponseType({
  id: "contract-stub",
  version: 1,
  validateQuestion(question, issue) {
    if (Object.keys(question.options).length > 0) issue(["options"], "桩形态不使用选项");
  },
  parseValue(value) {
    if (typeof value !== "string") throw new LearningError(422, "INVALID_RESPONSE");
    return value;
  },
  isAnswered: value => value.trim() !== "",
  parseKey: key => stubKey.safeParse(key).data,
});

export function stubQuestion(id: string, version = 1): ContractQuestion {
  return { id, version, prompt: `填写 ${id} 的口令。`, response: stubResponse.id };
}

export function stubKeyFor(acceptedToken: string) {
  return { acceptedToken };
}

export const pendingToken = "?";

export type StubWorld = {
  readonly databasePath: string;
  readonly evaluated: string[];
  readonly students: Set<string>;
  failuresLeft: number;
  recoveryAllowed: boolean;
  reviewAllowed: boolean;
  open(): Runtime;
};

function stubEvaluator(world: StubWorld): EvaluatorRegistration {
  return {
    ...evaluatorRef, responseTypes: [stubResponse.id],
    evaluate({ questionId, value, key }) {
      world.evaluated.push(questionId);
      if (world.failuresLeft > 0) {
        world.failuresLeft--;
        throw new Error("桩评估器故障");
      }
      if (value === pendingToken) return { status: "needsReview" };
      return { status: "judged", correct: value === stubKey.parse(key).acceptedToken };
    },
  };
}

function stubWorld(t: TestContext): StubWorld {
  const owns = (scope: ReviewScope) => world.reviewAllowed && scope.reviewerId === reviewer.id && world.students.has(scope.studentId);
  const world: StubWorld = {
    databasePath: scenarioDatabase(t), evaluated: [], students: new Set([student.id]), failuresLeft: 0, recoveryAllowed: true, reviewAllowed: true,
    open() {
      const runtime = openRuntime(world.databasePath, {
        responseTypes: [stubResponse], evaluators: [stubEvaluator(world)],
        authorizeConfirmationRecovery: () => world.recoveryAllowed, authorizeReview: owns,
      });
      let open = true;
      const close = runtime.close;
      t.after(() => { if (open) close(); });
      return { ...runtime, close() { open = false; close(); } };
    },
  };
  return world;
}

export const scenarioItems = ["submit", "authorize", "failure", "withdraw"] as const;
export type ScenarioItem = typeof scenarioItems[number];
const itemNames: Readonly<Record<ScenarioItem, string>> = { submit: "提交", authorize: "授权", failure: "失败终态", withdraw: "撤销" };

type ScenarioCase = Readonly<{ title: string; run: (world: StubWorld) => void }>;
export type ScenarioContract = Readonly<{
  group: string;
  items: Readonly<Record<ScenarioItem, ScenarioCase | Readonly<{ notApplicable: string }>>>;
}>;

const ledger = new URL("../../../docs/迁移契约台账/台账.md", import.meta.url);

function ledgerCell(group: string) {
  const lines = readFileSync(ledger, "utf8").split("\n");
  const header = lines.find(line => line.startsWith("| 组 |"))?.split("|").map(cell => cell.trim());
  const column = header?.indexOf("适用契约") ?? -1;
  const row = lines.find(line => line.startsWith(`| ${group} |`));
  assert.ok(row && column > 0, `台账缺少 ${group} 行或「适用契约」列`);
  return row.split("|")[column]?.trim() ?? "";
}

function ledgerApplicability(group: string) {
  const [declared = "", reasons = ""] = ledgerCell(group).split("；");
  const items = declared.replace(/（[^）]*）/g, "").split(/[/／]/).map(part => part.trim());
  return { applicable: scenarioItems.filter(item => items.includes(itemNames[item])), reasons };
}

export function scenarioContract({ group, items }: ScenarioContract) {
  const applicable = scenarioItems.filter(item => !("notApplicable" in items[item]));

  test(`${group}｜适用契约与台账「适用契约」列一致，不适用项写明原因`, () => {
    const declared = ledgerApplicability(group);
    assert.deepEqual(applicable, declared.applicable);
    for (const item of scenarioItems) {
      const entry = items[item];
      if (!("notApplicable" in entry)) continue;
      assert.ok(entry.notApplicable.trim().length > 0, `${group} ${itemNames[item]} 缺少不适用原因`);
      assert.ok(declared.reasons.includes(itemNames[item]) && declared.reasons.includes("不适用"), `台账未写明 ${group} ${itemNames[item]} 不适用`);
    }
  });

  for (const item of scenarioItems) {
    const entry = items[item];
    if ("notApplicable" in entry) continue;
    test(`${group}｜${itemNames[item]}：${entry.title}`, t => entry.run(stubWorld(t)));
  }
}
