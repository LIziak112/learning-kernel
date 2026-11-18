import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createDemoServer } from "../../src/host/demo.ts";
import publication from "../../practices/single-quote.json" with { type: "json" };

let coverageSequence = 0;

test("浏览器拖选原文并提交，刷新可回看，另一学生读不到", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin) => {
    const student = await openBrowserPage(browser, { width: 1200, height: 850 });
    await openActivity(student, origin, true);
    assert.equal(await student.locator("#load-error").isVisible(), false);
    assert.notEqual(await student.locator("#submit-error").getAttribute("hidden"), null);
    assert.equal(await student.getByRole("button", { name: "打开活动" }).isVisible(), false);
    assert.equal(await student.getByRole("button", { name: "提交引文" }).isDisabled(), true);
    const paragraph = publication.material.paragraphs[0];
    assert.ok(paragraph);
    const selected = paragraph.text.slice(0, 10);
    const outside = await student.evaluate(async () => {
      const selection = document.getSelection();
      if (!selection) throw new Error("浏览器缺少选区");
      const errors: string[] = [];
      const onError = (error: ErrorEvent) => errors.push(error.message);
      window.addEventListener("error", onError);
      const range = document.createRange();
      range.selectNodeContents(document);
      const changed = new Promise<void>(resolve => {
        document.addEventListener("selectionchange", () => resolve(), { once: true });
      });
      selection.addRange(range);
      await changed;
      const startsAtDocument = selection.getRangeAt(0).startContainer === document;
      selection.removeAllRanges();
      window.removeEventListener("error", onError);
      return { startsAtDocument, errors };
    });
    assert.deepEqual(outside, { startsAtDocument: true, errors: [] });
    await student.evaluate(async () => {
      const paragraphs = document.querySelectorAll("[data-paragraph]");
      const first = paragraphs.item(0);
      const second = paragraphs.item(1);
      const selection = document.getSelection();
      if (!first || !second || !selection) throw new Error("选区工具缺少原文");
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(second, 1);
      const changed = new Promise<void>(resolve => {
        document.addEventListener("selectionchange", () => resolve(), { once: true });
      });
      selection.addRange(range);
      await changed;
    });
    assert.equal(await student.getByRole("button", { name: "提交引文" }).isDisabled(), true);
    await student.evaluate(() => document.getSelection()?.removeAllRanges());
    await dragSelection(student, paragraph.text, 1);
    await student.locator("#quote-preview").getByText(paragraph.text.slice(0, 1), { exact: true }).waitFor();
    await student.evaluate(() => document.getSelection()?.removeAllRanges());
    await dragSelection(student, paragraph.text, selected.length);
    await student.locator("#quote-preview").getByText(selected, { exact: true }).waitFor();
    await student.getByRole("button", { name: "提交引文" }).click();
    await student.getByText("活动已完成", { exact: true }).waitFor();
    await student.getByText("提交回执", { exact: true }).waitFor();
    const receipt = await student.locator("#receipt-id").textContent();
    assert.match(receipt ?? "", /^[0-9a-f-]{36}$/);

    await savePageCoverage(student, true);
    await student.route("**/api/activities/*", route => route.abort("connectionfailed"), { times: 1 });
    await student.reload();
    await student.getByText("无法打开活动，请刷新或重试。", { exact: true }).waitFor();
    await savePageCoverage(student, true);
    await student.reload();
    await student.getByText("活动已完成", { exact: true }).waitFor();
    await student.locator("#quote-preview").getByText(selected, { exact: true }).waitFor();
    assert.equal(await student.locator("#receipt-id").textContent(), receipt);
    assert.equal(await student.locator("#load-error").isVisible(), false);
    assert.doesNotMatch(await student.locator("main").innerText(), /待评|分数|得分/);
    assert.equal(await student.getByRole("button", { name: "提交引文" }).count(), 0);
    assert.equal(await student.getByRole("button", { name: "选用本段" }).count(), 0);

    const other = await openBrowserPage(browser);
    await other.goto(origin + "/demo/other");
    const denied = other.waitForResponse(response => response.url().includes("/api/activities/") && response.status() === 403);
    await other.goto(student.url());
    const deniedURL = (await denied).url();
    const repeatedDenial = await other.request.get(deniedURL);
    assert.equal(repeatedDenial.status(), 403);
    assert.deepEqual(await repeatedDenial.json(), { code: "FORBIDDEN" });
    await other.getByText("当前账号无权查看此活动。", { exact: true }).waitFor();
    const visible = await other.locator("main").innerText();
    assert.ok(!visible.includes(selected));
    assert.ok(!visible.includes(receipt ?? ""));
    assert.equal(await other.locator("#receipt-id").textContent(), "");
  });
});

test("提交已确认但浏览器丢失回执时，保留引文并重发原操作", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin) => {
    const student = await openBrowserPage(browser, { width: 390, height: 844 });
    await openActivity(student, origin);
    const paragraph = publication.material.paragraphs[0];
    const nextParagraph = publication.material.paragraphs[1];
    assert.ok(paragraph && nextParagraph);
    await student.getByRole("button", { name: "选用本段" }).last().click();
    await student.route("**/api/activities/*/drafts", route => route.abort("connectionfailed"), { times: 1 });
    await student.getByRole("button", { name: "提交引文" }).click();
    await student.getByText("未收到确认。可以用同一选区重试。", { exact: true }).waitFor();
    await student.locator("#quote-preview").getByText(nextParagraph.text, { exact: true }).waitFor();
    await student.getByRole("button", { name: "选用本段" }).first().click();
    assert.equal(await student.locator("#submit-error").isVisible(), false);
    const submissions: unknown[] = [];
    let committed: unknown;
    const release = Promise.withResolvers<void>();
    await student.route("**/api/activities/*/submissions", async route => {
      submissions.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (submissions.length === 1) {
        assert.equal(response.status(), 200);
        committed = await response.json();
        await release.promise;
        await route.abort("connectionfailed");
        return;
      }
      assert.equal(response.status(), 200);
      assert.deepEqual(await response.json(), committed);
      await route.fulfill({ response });
    });
    await student.getByRole("button", { name: "提交引文" }).click();
    try {
      await student.getByRole("button", { name: "提交中…" }).waitFor();
      assert.equal(await student.getByRole("button", { name: "提交中…" }).isDisabled(), true);
      assert.equal(await student.getByRole("button", { name: "选用本段" }).last().isDisabled(), true);
      await student.getByRole("button", { name: "提交中…" }).dispatchEvent("click");
      await dragSelection(student, nextParagraph.text, 8);
      await student.locator("#quote-preview").getByText(paragraph.text, { exact: true }).waitFor();
    } finally {
      release.resolve();
    }
    await student.getByText("未收到确认。可以用同一选区重试。", { exact: true }).waitFor();
    assert.equal(await student.getByRole("button", { name: "选用本段" }).last().isDisabled(), true);
    await student.evaluate(() => document.getSelection()?.removeAllRanges());
    await dragSelection(student, nextParagraph.text, 8);
    await student.locator("#quote-preview").getByText(paragraph.text, { exact: true }).waitFor();
    await student.getByRole("button", { name: "重试提交" }).click();
    await student.getByText("活动已完成", { exact: true }).waitFor();
    assert.notEqual(await student.locator("#submit-error").getAttribute("hidden"), null);
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[1], submissions[0]);
    assert.match(await student.locator("#receipt-id").innerText(), /^[0-9a-f-]{36}$/);
    assert.equal(await student.evaluate(() => document.documentElement.scrollWidth), 390);
  });
});

test("会话失效时清除页面引文，重新进入后可恢复活动", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin) => {
    const student = await openBrowserPage(browser);
    await openActivity(student, origin);
    const activityURL = student.url();
    const paragraph = publication.material.paragraphs[0];
    assert.ok(paragraph);
    await student.getByRole("button", { name: "选用本段" }).first().click();
    await student.locator("#quote-preview").getByText(paragraph.text, { exact: true }).waitFor();
    await student.context().clearCookies();
    await student.getByRole("button", { name: "提交引文" }).click();
    const login = student.getByRole("link", { name: "进入演示学生会话" });
    await login.waitFor();
    assert.ok(!(await student.locator("main").textContent())?.includes(paragraph.text));
    assert.equal(await student.getByText("进行中", { exact: true }).count(), 0);
    await savePageCoverage(student, true);
    await login.click();
    await student.getByRole("button", { name: "打开活动" }).click();
    await student.getByRole("heading", { name: publication.material.title }).waitFor();
    assert.equal(student.url(), activityURL);
    assert.equal(await student.getByText("进行中", { exact: true }).count(), 1);
    assert.equal(await student.getByText("拖选同一段中的文字，也可以选用整段。").isVisible(), true);
  });
});

async function withDemo(t: TestContext, run: (browser: Browser, origin: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createDemoServer(join(directory, "test.sqlite"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch();
    try {
      await run(browser, `http://127.0.0.1:${address.port}`);
    } finally {
      try {
        for (const context of browser.contexts()) {
          for (const page of context.pages()) await savePageCoverage(page);
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function openBrowserPage(browser: Browser, viewport = { width: 1200, height: 850 }) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(4000);
  if (process.env.NODE_V8_COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
  return page;
}

async function savePageCoverage(page: Page, restart = false) {
  const directory = process.env.NODE_V8_COVERAGE;
  if (!directory) return;
  const file = new URL("../../src/host/web/reading.mjs", import.meta.url);
  const entries = (await page.coverage.stopJSCoverage())
    .filter(entry => new URL(entry.url).pathname === "/reading.mjs");
  assert.ok(entries.length > 0, "Chromium 未记录阅读页脚本覆盖率");
  for (const entry of entries) {
    coverageSequence += 1;
    const result = [{ scriptId: String(coverageSequence), url: file.href, functions: entry.functions }];
    writeFileSync(join(directory, `coverage-${process.pid}-${Date.now()}-${coverageSequence}.json`),
      JSON.stringify({ result }));
  }
  if (restart) await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

async function openActivity(page: Page, origin: string, failFirst = false) {
  const response = await page.goto(origin + "/demo/student");
  assert.equal(response?.status(), 200, await response?.text());
  const button = page.getByRole("button", { name: "打开活动" });
  if (failFirst) {
    const release = Promise.withResolvers<void>();
    await page.route("**/demo/entry", async route => {
      await release.promise;
      await route.abort("connectionfailed");
    }, { times: 1 });
    try {
      await button.click();
      assert.equal(await button.isDisabled(), true);
    } finally {
      release.resolve();
    }
    await page.getByText("无法打开活动，请刷新或重试。", { exact: true }).waitFor();
  }
  await button.click({ timeout: 3000 });
  await page.getByRole("heading", { name: publication.material.title }).waitFor({ timeout: 3000 });
}

async function dragSelection(page: Page, paragraph: string, end: number) {
  const endpoints = await page.getByText(paragraph, { exact: true }).evaluate((element, length) => {
    const text = element.firstChild;
    if (!text) throw new Error("原文段落缺少文本");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const first = range.getBoundingClientRect();
    range.setStart(text, length - 1);
    range.setEnd(text, length);
    const last = range.getBoundingClientRect();
    return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
  }, end);
  await page.mouse.move(endpoints.x1, endpoints.y1);
  await page.mouse.down();
  await page.mouse.move(endpoints.x2, endpoints.y2, { steps: 12 });
  await page.mouse.up();
}
