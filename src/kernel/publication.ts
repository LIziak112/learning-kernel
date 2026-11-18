import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { publicationSchema } from "../contracts/reading.ts";
import { writeTransaction } from "./database.ts";

const storedDefinition = z.object({ definition: z.string() });

export function registerPublication(database: DatabaseSync, input: unknown) {
  const { material, practice } = publicationSchema.parse(input);
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
    const storedMaterial = storedDefinition.parse(database.prepare("SELECT definition FROM materials WHERE id = ? AND version = ?")
      .get(material.id, material.version));
    const storedPractice = storedDefinition.parse(database.prepare("SELECT definition FROM practices WHERE id = ? AND version = ?")
      .get(practice.id, practice.version));
    if (storedMaterial.definition !== materialJSON || storedPractice.definition !== practiceJSON) {
      throw new Error("已发布的材料或练法版本不能更改");
    }
  });
}
