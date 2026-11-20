import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/kernel/database.ts";
import { readingMigration } from "../src/kernel/reading-migration.ts";
import { registerPublication } from "../src/kernel/publication.ts";
import { openLearningRuntime } from "../src/server.ts";
import single from "../practices/single-quote.json" with { type: "json" };

const appliedVersions = Array.from({ length: 18 }, (_, index) => index + 1);

test("同一文件库重复初始化只应用一次首迁移，关闭重开仍可读到版本", t => {
  const path = temporaryDatabasePath(t);
  let initial;

  {
    using database = openDatabase(path);
    initial = migrationState(database);
    assert.deepEqual(initial.versions, appliedVersions);
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
  assert.deepEqual(migrationState(recovered).versions, appliedVersions);
});

test("保留 T01 已应用的迁移记录并拒绝比程序新的数据库版本", t => {
  const path = temporaryDatabasePath(t);
  const futureVersion = appliedVersions.length + 1;
  {
    using original = new DatabaseSync(path);
    original.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
      INSERT INTO schema_migrations (version) VALUES (1);
    `);
  }
  {
    using upgraded = openDatabase(path);
    assert.deepEqual(migrationState(upgraded).versions, appliedVersions);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 0);
    upgraded.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(futureVersion);
  }
  assert.throws(() => openDatabase(path), { message: `不支持的数据库版本：${futureVersion}` });
  using reopened = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(migrationState(reopened).versions, [...appliedVersions, futureVersion]);
});

test("空迁移记录与版本 0 均拒绝升级且保留原记录", t => {
  for (const version of [null, 0]) {
    const path = temporaryDatabasePath(t);
    using original = new DatabaseSync(path);
    original.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT");
    if (version !== null) original.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    assert.throws(() => openDatabase(path), { message: `不支持的数据库版本：${version}` });
    assert.deepEqual(migrationState(original).versions, version === null ? [] : [version]);
    assert.equal(original.prepare("SELECT name FROM sqlite_schema WHERE name = 'practices'").get(), undefined);
  }
});

test("从 T03 版本迁移时原样保留发布、活动和已有表现标识", t => {
  const path = temporaryDatabasePath(t);
  const activityId = randomUUID();
  const stepAttemptId = randomUUID();
  const submissionId = randomUUID();
  const startedAt = "2026-11-19T00:00:00.000Z";
  const confirmedAt = "2026-11-19T00:01:00.000Z";
  const [step] = single.practice.steps;
  const [paragraph] = single.material.paragraphs;
  assert.ok(step && paragraph);
  const selection = {
    material: single.practice.material, positionId: step.positionId,
    range: { paragraphId: paragraph.id, start: 0, end: 1 }, text: paragraph.text.slice(0, 1),
  };
  {
    using original = new DatabaseSync(path);
    installT03(original);
    registerPublication(original, single);
    original.prepare(`
      INSERT INTO activities (id, student_id, practice_id, practice_version, start_operation_id, started_at)
      VALUES (?, 'student', ?, ?, 'start', ?)
    `).run(activityId, single.practice.id, single.practice.version, startedAt);
    original.prepare("INSERT INTO step_attempts (id, activity_id, step_id) VALUES (?, ?, ?)").run(stepAttemptId, activityId, step.id);
    original.prepare("INSERT INTO works (id, activity_id) VALUES ('work', ?)").run(activityId);
    original.prepare("INSERT INTO work_versions (work_id, version, selection) VALUES ('work', 1, ?)").run(JSON.stringify(selection));
    original.prepare(`
      INSERT INTO submissions (id, step_attempt_id, slot_id, operation_id, work_id, work_version, confirmed_at)
      VALUES (?, ?, 'quote', 'confirm', 'work', 1, ?)
    `).run(submissionId, stepAttemptId, confirmedAt);
    original.prepare("INSERT INTO performances VALUES ('original-observation', ?, 'cite')").run(submissionId);
    original.prepare("INSERT INTO completions (activity_id, submission_id) VALUES (?, ?)").run(activityId, submissionId);
  }
  using upgraded = openDatabase(path);
  assert.deepEqual(migrationState(upgraded).versions, appliedVersions);
  const activity = upgraded.prepare(`
    SELECT a.id, p.definition FROM activities a JOIN practices p
      ON p.id = a.practice_id AND p.version = a.practice_version
  `).get();
  assert.equal(activity?.id, activityId);
  assert.deepEqual(JSON.parse(String(activity?.definition)), single.practice);
  assert.deepEqual(upgraded.prepare("SELECT id, ordinal FROM step_attempts").all().map(row => [row.id, row.ordinal]), [[stepAttemptId, 0]]);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM scoring_keys").get()?.count, 0);
  const performance = upgraded.prepare("SELECT id, submission_id, target_id, unit_id FROM performances").get();
  assert.deepEqual(Object.values(performance ?? {}), ["original-observation", submissionId, "cite", "wholeSelection"]);
  assert.equal(upgraded.prepare("SELECT submission_id FROM completions WHERE activity_id = ?").get(activityId)?.submission_id, submissionId);
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);

  const runtime = openLearningRuntime({ databasePath: path });
  try {
    const student = { role: "student", id: "student" } as const;
    const receipt = runtime.start(student, { protocolVersion: 1, operationId: "start", practiceId: single.practice.id, practiceVersion: 1 });
    assert.deepEqual(receipt, { activityId, stepAttemptId, startedAt });
    const restored = runtime.read(student, activityId);
    assert.equal(restored.status, "completed");
    assert.deepEqual(restored.material, single.material);
    assert.deepEqual(restored.submission, { receipt: { id: submissionId, stepAttemptId, slotId: "quote", confirmedAt }, selection });
  } finally {
    runtime.close();
  }
});

test("升级发现旧库缺失材料时回滚，恢复依赖后仍校验成对材料和外键", t => {
  const path = temporaryDatabasePath(t);
  using original = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  installT03(original);
  original.exec("INSERT INTO practices VALUES ('old', 1, 'missing', 1, '{}')");
  assert.throws(() => openDatabase(path), /数据库迁移后的外键检查失败/);
  assert.deepEqual(migrationState(original).versions, [1, 2]);
  assert.equal(original.prepare("SELECT material_id FROM practices WHERE id = 'old'").get()?.material_id, "missing");
  original.exec("INSERT INTO materials VALUES ('missing', 1, '{}')");

  using upgraded = openDatabase(path);
  assert.equal(upgraded.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.throws(() => upgraded.exec("INSERT INTO practices VALUES ('half', 1, NULL, 1, '{}')"), /CHECK constraint failed/);
  assert.throws(() => upgraded.exec("INSERT INTO practices VALUES ('broken', 1, 'unknown', 1, '{}')"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
});

function installT03(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
    INSERT INTO schema_migrations (version) VALUES (1), (2);
    ${readingMigration}
  `);
}

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
