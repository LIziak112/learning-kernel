import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readingMigration } from "./reading-migration.ts";
import { evaluationMigration } from "./evaluation-migration.ts";
import { verdictMigration } from "./verdict-migration.ts";
import { questionPublicationMigration } from "./question-publication-migration.ts";
import { choiceDraftMigration, currentChoiceDraftMigration } from "./choice-draft-migration.ts";
import { preparedActivityMigration } from "./prepared-activity-migration.ts";

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
  `
    ALTER TABLE reading_reviews ADD COLUMN reviewer_active INTEGER NOT NULL DEFAULT 1 CHECK (reviewer_active IN (0, 1));
    ALTER TABLE reading_reviews ADD COLUMN student_active INTEGER NOT NULL DEFAULT 1 CHECK (student_active IN (0, 1));
    ALTER TABLE reading_reviews ADD COLUMN redo_authorized INTEGER NOT NULL DEFAULT 0 CHECK (redo_authorized IN (0, 1));
    ALTER TABLE activities ADD COLUMN redo_of TEXT REFERENCES activities (id);
  `,
  questionPublicationMigration,
  choiceDraftMigration,
  `
    ALTER TABLE activities ADD COLUMN last_choice_changed_at TEXT;
    ALTER TABLE activities ADD COLUMN first_choice_changed_at TEXT
      CHECK (first_choice_changed_at IS NULL OR last_choice_changed_at IS NOT NULL);
  `,
  currentChoiceDraftMigration,
  preparedActivityMigration,
];

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: false });
  try {
    writeTransaction(database, () => migrate(database));
    database.exec("PRAGMA foreign_keys = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function writeTransaction<Result>(database: DatabaseSync, write: () => Result): Result {
  return inTransaction(database, "BEGIN IMMEDIATE", write);
}

export function readTransaction<Result>(database: DatabaseSync, read: () => Result): Result {
  return database.isTransaction ? read() : inTransaction(database, "BEGIN", read);
}

function inTransaction<Result>(database: DatabaseSync, begin: "BEGIN" | "BEGIN IMMEDIATE", operation: () => Result): Result {
  database.exec(begin);
  try {
    const result = operation();
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
  const latestVersion = migrations.length + 1;
  if (version === null || version < 1 || version > latestVersion) {
    throw new Error(`不支持的数据库版本：${String(version)}`);
  }
  if (version === latestVersion) return;
  const record = database.prepare("INSERT INTO schema_migrations (version) VALUES (?)");
  for (const [index, sql] of migrations.entries()) {
    const nextVersion = index + 2;
    if (nextVersion <= version) continue;
    database.exec(sql);
    record.run(nextVersion);
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("数据库迁移后的外键检查失败");
}
