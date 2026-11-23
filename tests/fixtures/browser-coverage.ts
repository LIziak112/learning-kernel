import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

let coverageSequence = 0;

export async function savePageCoverage(page: Page, restart = false) {
  const directory = process.env.NODE_V8_COVERAGE;
  if (!directory) return;
  const scripts = new Set(["/reading.mjs", "/library-reading.mjs", "/teacher.mjs", "/api.mjs"]);
  const entries = (await page.coverage.stopJSCoverage()).filter(entry => scripts.has(new URL(entry.url).pathname));
  assert.ok(entries.length > 0, "Chromium 未记录演示宿主脚本覆盖率");
  for (const entry of entries) {
    coverageSequence += 1;
    const file = new URL("../../src/host/web" + new URL(entry.url).pathname, import.meta.url);
    const result = [{ scriptId: String(coverageSequence), url: file.href, functions: entry.functions }];
    writeFileSync(join(directory, `coverage-${process.pid}-${Date.now()}-${coverageSequence}.json`), JSON.stringify({ result }));
  }
  if (restart) await page.coverage.startJSCoverage({ resetOnNavigation: false });
}
