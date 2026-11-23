import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { materialSchema } from "../contracts/reading.ts";
import type { Material, VersionRef } from "../contracts/reading.ts";
import type { ReadingPublication, ReadingStep } from "../contracts/reading-publication.ts";
import type { Registry } from "./registry.ts";

type Issue = (path: (string | number)[], message: string) => void;
type MaterialUse = { reference: VersionRef | undefined; path: (string | number)[] };

export function validateMaterialPositions({ material, materials, practice }: ReadingPublication, registry: Registry, issue: Issue) {
  const uses = materialUses(practice.steps);
  if (materials === undefined) {
    if (uses.length > 0 && !practice.material) issue(["practice", "material"], "绑定材料输入时须声明材料版本");
    for (const { reference, path } of uses) {
      if (reference) issue(path, "显式材料引用须提供同次发布的材料定义");
    }
    return;
  }
  if (material || practice.material) issue(["materials"], "显式材料位置不能与旧单材料声明混用");
  requireSingleAnswerStep(practice.steps, registry, issue);
  validateMaterialClosure(materials, uses, issue);
}

function materialUses(steps: readonly ReadingStep[]): MaterialUse[] {
  return steps.flatMap((step, index) => Object.entries(step.inputs).flatMap(([name, input]) => input.from === "material"
    ? [{ reference: input.material, path: ["practice", "steps", index, "inputs", name, "material"] }]
    : []));
}

function requireSingleAnswerStep(steps: ReadingPublication["practice"]["steps"], registry: Registry, issue: Issue) {
  const [step] = steps;
  if (steps.length !== 1 || step.submit.purpose !== "finalAnswer" || registry.tool(step.tool)?.supportsMaterialPositions !== true) {
    issue(["practice", "steps"], "显式材料位置须绑定到声明支持材料位置的工具的单步最终作答");
  }
}

function validateMaterialClosure(materials: readonly Material[], uses: readonly MaterialUse[], issue: Issue) {
  const definitions = new Map<string, number>();
  for (const [index, material] of materials.entries()) {
    const key = materialKey(material);
    if (definitions.has(key)) issue(["materials", index], "材料版本定义重复");
    definitions.set(key, index);
  }

  const referenced = new Set<string>();
  for (const { reference, path } of uses) {
    if (!reference) {
      issue(path, "显式材料位置须声明固定的材料版本");
      continue;
    }
    const key = materialKey(reference);
    if (!definitions.has(key)) issue(path, "未提供此位置引用的材料版本");
    referenced.add(key);
  }

  for (const [key, index] of definitions) {
    if (!referenced.has(key)) issue(["materials", index], "发布材料须绑定至少一个实际使用位置");
  }
}

function materialKey({ id, version }: VersionRef) {
  return JSON.stringify([id, version]);
}

const storedDefinition = z.object({ definition: z.string() });
export function loadMaterialAtVersion(database: DatabaseSync, { id, version }: VersionRef): Material {
  const row = database.prepare("SELECT definition FROM materials WHERE id = ? AND version = ?").get(id, version);
  if (!row) throw new Error("活动引用的已发布材料不存在");
  const material = materialSchema.parse(JSON.parse(storedDefinition.parse(row).definition));
  if (material.id !== id || material.version !== version) throw new Error("活动引用的材料与已发布版本不一致");
  return material;
}
