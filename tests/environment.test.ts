import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";

test("工具链可以使用内置 SQLite 和锁定的 Zod", () => {
  using database = new DatabaseSync(":memory:");
  const row = database.prepare("SELECT sqlite_version() AS version").get();
  const result = z.object({ version: z.string() }).parse(row);
  assert.match(result.version, /^\d+\.\d+\.\d+$/);
});
