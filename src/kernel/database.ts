import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readingMigration } from "./reading-migration.ts";
import { evaluationMigration } from "./evaluation-migration.ts";
import { verdictMigration } from "./verdict-migration.ts";

const migrationVersion = z.object({ version: z.int().nullable() });
const migrations = [
  readingMigration,
  `
    CREATE TABLE scoring_keys (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      PRIMARY KEY (id, version)
    ) STRICT;
  `,
  `
    ALTER TABLE step_attempts ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0);
    CREATE UNIQUE INDEX step_attempt_order ON step_attempts (activity_id, ordinal);
    ALTER TABLE works ADD COLUMN step_attempt_id TEXT REFERENCES step_attempts (id);
    ALTER TABLE works ADD COLUMN slot_id TEXT CHECK ((slot_id IS NULL) = (step_attempt_id IS NULL));
  `,
  evaluationMigration,
  verdictMigration,
  `
    ALTER TABLE reading_reviews ADD COLUMN review_open INTEGER NOT NULL DEFAULT 0 CHECK (review_open IN (0, 1));
  `,
];

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { timeout: 5000 });
  try {
    writeTransaction(database, () => migrate(database));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function writeTransaction<Result>(database: DatabaseSync, write: () => Result): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function migrate(database: DatabaseSync) {
  const migrationTable = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!migrationTable) {
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
      INSERT INTO schema_migrations (version) VALUES (1);
    `);
  }
  const { version } = migrationVersion.parse(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get());
  if (version === null || version < 1 || version > migrations.length + 1) {
    throw new Error(`不支持的数据库版本：${String(version)}`);
  }
  const record = database.prepare("INSERT INTO schema_migrations (version) VALUES (?)");
  for (const [index, sql] of migrations.entries()) {
    const nextVersion = index + 2;
    if (nextVersion <= version) continue;
    database.exec(sql);
    record.run(nextVersion);
  }
}
