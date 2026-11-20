import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { publicationSchema } from "../contracts/reading.ts";
import type { Material, VersionRef } from "../contracts/reading.ts";
import { readingPublicationSchema } from "../contracts/reading-publication.ts";
import { writeTransaction } from "./database.ts";
import { validateBindings } from "./publication-bindings.ts";
import type { PublicationEvaluators } from "./publication-bindings.ts";

const storedDefinition = z.object({ definition: z.string() });
const publicationFormat = z.object({ practice: z.object({ formatVersion: z.unknown().optional() }) });
function parseReadingPublication(input: unknown, registered: PublicationEvaluators) {
  return readingPublicationSchema.superRefine((value, context) => {
    validateBindings(value, (path, message) => context.addIssue({ code: "custom", path, message }), registered);
  }).parse(input);
}

export function registerPublication(database: DatabaseSync, input: unknown, registered: PublicationEvaluators = {}) {
  const { practice: format } = publicationFormat.parse(input);
  const { material, materials, practice, scoringKey } = Object.hasOwn(format, "formatVersion")
    ? parseReadingPublication(input, registered)
    : { ...publicationSchema.parse(input), materials: undefined, scoringKey: undefined };
  requireMatchingMaterial(practice.material, material);
  const practiceJSON = JSON.stringify(practice);
  writeTransaction(database, () => {
    registerMaterials(database, material, materials);
    database.prepare(`
      INSERT INTO practices (id, version, material_id, material_version, definition) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id, version) DO NOTHING
    `).run(practice.id, practice.version, material?.id ?? null, material?.version ?? null, practiceJSON);
    requireUnchanged(database, "practices", practice, practiceJSON);
    if (scoringKey) {
      const definition = JSON.stringify(scoringKey);
      database.prepare(`
        INSERT INTO scoring_keys (id, version, definition) VALUES (?, ?, ?)
        ON CONFLICT (id, version) DO NOTHING
      `).run(scoringKey.id, scoringKey.version, definition);
      requireUnchanged(database, "scoring_keys", scoringKey, definition);
    }
  });
}

function registerMaterials(database: DatabaseSync, single: Material | undefined, multiple: readonly Material[] | undefined) {
  const materials = multiple ?? (single ? [single] : []);
  for (const material of materials) {
    const definition = JSON.stringify(material);
    database.prepare(`
      INSERT INTO materials (id, version, definition) VALUES (?, ?, ?)
      ON CONFLICT (id, version) DO NOTHING
    `).run(material.id, material.version, definition);
    requireUnchanged(database, "materials", material, definition);
  }
}

function requireMatchingMaterial(reference: VersionRef | undefined, material: VersionRef | undefined) {
  if (reference?.id !== material?.id || reference?.version !== material?.version) {
    throw new Error("练法引用的材料版本与发布材料不一致");
  }
}

function requireUnchanged(
  database: DatabaseSync,
  table: "materials" | "practices" | "scoring_keys",
  { id, version }: VersionRef,
  definition: string,
) {
  const stored = storedDefinition.parse(database.prepare(`SELECT definition FROM ${table} WHERE id = ? AND version = ?`)
    .get(id, version));
  if (stored.definition !== definition) throw new Error("已发布的材料、练法或评分键版本不能更改");
}
