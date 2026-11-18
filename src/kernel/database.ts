import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readingMigration } from "./reading-migration.ts";

const migrationVersion = z.object({ version: z.int().nullable() });

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
  if (version === 1) {
    database.exec(readingMigration);
    database.exec("INSERT INTO schema_migrations (version) VALUES (2)");
  } else if (version !== 2) {
    throw new Error(`不支持的数据库版本：${String(version)}`);
  }
}
