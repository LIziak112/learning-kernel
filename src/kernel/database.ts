import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readingMigration } from "./reading-migration.ts";

const migrationVersion = z.object({ version: z.int().nullable() });
const migrationVersions = new Set<number | null>([1, 2, 3, 4]);

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
  const migrations = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!migrations) {
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
      INSERT INTO schema_migrations (version) VALUES (1);
    `);
  }
  const { version } = migrationVersion.parse(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get());
  if (!migrationVersions.has(version)) throw new Error(`不支持的数据库版本：${String(version)}`);
  if (version === 1) {
    database.exec(readingMigration);
    database.exec("INSERT INTO schema_migrations (version) VALUES (2)");
  }
  if (version === 1 || version === 2) {
    database.exec(`
      CREATE TABLE scoring_keys (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        PRIMARY KEY (id, version)
      ) STRICT;
      INSERT INTO schema_migrations (version) VALUES (3);
    `);
  }
  if (version !== 4) {
    database.exec(`
      ALTER TABLE step_attempts ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0);
      CREATE UNIQUE INDEX step_attempt_order ON step_attempts (activity_id, ordinal);
      ALTER TABLE works ADD COLUMN step_attempt_id TEXT REFERENCES step_attempts (id);
      ALTER TABLE works ADD COLUMN slot_id TEXT CHECK ((slot_id IS NULL) = (step_attempt_id IS NULL));
      INSERT INTO schema_migrations (version) VALUES (4);
    `);
  }
}
