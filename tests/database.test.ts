import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/kernel/database.ts";

test("同一文件库重复初始化只应用一次首迁移，关闭重开仍可读到版本", t => {
  const path = temporaryDatabasePath(t);
  let initial;

  {
    using database = openDatabase(path);
    initial = migrationState(database);
    assert.deepEqual(initial.versions, [1]);
    assert.equal(typeof initial.schemaVersion, "number");

    using repeated = openDatabase(path);
    assert.deepEqual(migrationState(repeated), initial);
  }

  using reopened = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(migrationState(reopened), initial);
});

test("首迁移遇到同名视图时保留原有内容并释放写锁", t => {
  const path = temporaryDatabasePath(t);
  using existing = new DatabaseSync(path);
  existing.exec("CREATE VIEW schema_migrations AS SELECT 42 AS version");

  assert.throws(() => openDatabase(path), /schema_migrations already exists/);
  assert.deepEqual(migrationState(existing).versions, [42]);
  existing.exec("DROP VIEW schema_migrations");

  using recovered = openDatabase(path);
  assert.deepEqual(migrationState(recovered).versions, [1]);
});

function temporaryDatabasePath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "database.sqlite");
}

function migrationState(database: DatabaseSync) {
  return {
    versions: database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version),
    schemaVersion: database.prepare("PRAGMA schema_version").get()?.schema_version,
  };
}
