import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { timeout: 5000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    const migrations = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (!migrations) {
      database.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
        INSERT INTO schema_migrations (version) VALUES (1);
      `);
    }
    database.exec("COMMIT");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
