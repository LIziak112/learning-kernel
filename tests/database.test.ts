import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/kernel/database.ts";
import { readingMigration } from "../src/kernel/reading-migration.ts";
import { registerPublication } from "../src/kernel/publication.ts";
import single from "../practices/single-quote.json" with { type: "json" };

test("同一文件库重复初始化只应用一次首迁移，关闭重开仍可读到版本", t => {
  const path = temporaryDatabasePath(t);
  let initial;

  {
    using database = openDatabase(path);
    initial = migrationState(database);
    assert.deepEqual(initial.versions, [1, 2, 3]);
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
  assert.deepEqual(migrationState(recovered).versions, [1, 2, 3]);
});

test("保留 T01 已应用的迁移记录并拒绝比程序新的数据库版本", t => {
  const path = temporaryDatabasePath(t);
  {
    using original = new DatabaseSync(path);
    original.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
      INSERT INTO schema_migrations (version) VALUES (1);
    `);
  }
  {
    using upgraded = openDatabase(path);
    assert.deepEqual(migrationState(upgraded).versions, [1, 2, 3]);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 0);
    upgraded.exec("INSERT INTO schema_migrations (version) VALUES (4)");
  }
  assert.throws(() => openDatabase(path), /不支持的数据库版本：4/);
  using reopened = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(migrationState(reopened).versions, [1, 2, 3, 4]);
});

test("从 T03 版本迁移时原样保留单步发布和活动", t => {
  const path = temporaryDatabasePath(t);
  {
    using original = new DatabaseSync(path);
    original.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
      INSERT INTO schema_migrations (version) VALUES (1), (2);
      ${readingMigration}
    `);
    registerPublication(original, single);
    original.prepare(`
      INSERT INTO activities (id, student_id, practice_id, practice_version, start_operation_id, started_at)
      VALUES ('activity', 'student', ?, ?, 'start', '2026-11-19T00:00:00Z')
    `).run(single.practice.id, single.practice.version);
  }
  using upgraded = openDatabase(path);
  assert.deepEqual(migrationState(upgraded).versions, [1, 2, 3]);
  const activity = upgraded.prepare(`
    SELECT a.id, p.definition FROM activities a JOIN practices p
      ON p.id = a.practice_id AND p.version = a.practice_version
  `).get();
  assert.equal(activity?.id, "activity");
  assert.deepEqual(JSON.parse(String(activity?.definition)), single.practice);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM scoring_keys").get()?.count, 0);
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
