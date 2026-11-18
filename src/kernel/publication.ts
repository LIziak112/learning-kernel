import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { publicationSchema } from "../contracts/reading.ts";
import type { VersionRef } from "../contracts/reading.ts";
import { readingPublicationSchema } from "../contracts/reading-publication.ts";
import { writeTransaction } from "./database.ts";
import { validateBindings } from "./publication-bindings.ts";

const storedDefinition = z.object({ definition: z.string() });
const publicationFormat = z.object({ practice: z.object({ formatVersion: z.unknown().optional() }) });
const validatedReading = readingPublicationSchema.superRefine((value, context) => {
  validateBindings(value, (path, message) => context.addIssue({ code: "custom", path, message }));
});

export function registerPublication(database: DatabaseSync, input: unknown) {
  const { practice: format } = publicationFormat.parse(input);
  const { material, practice, scoringKey } = Object.hasOwn(format, "formatVersion")
    ? validatedReading.parse(input)
    : { ...publicationSchema.parse(input), scoringKey: undefined };
  if (practice.material.id !== material.id || practice.material.version !== material.version) {
    throw new Error("练法引用的材料版本与发布材料不一致");
  }
  const materialJSON = JSON.stringify(material);
  const practiceJSON = JSON.stringify(practice);
  writeTransaction(database, () => {
    database.prepare(`
      INSERT INTO materials (id, version, definition) VALUES (?, ?, ?)
      ON CONFLICT (id, version) DO NOTHING
    `).run(material.id, material.version, materialJSON);
    database.prepare(`
      INSERT INTO practices (id, version, material_id, material_version, definition) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id, version) DO NOTHING
    `).run(practice.id, practice.version, material.id, material.version, practiceJSON);
    requireUnchanged(database, "materials", material, materialJSON);
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
