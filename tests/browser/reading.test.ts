import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { createDemoServer } from "../../src/host/demo.ts";
import { evaluatePending } from "../../src/kernel/pending-evaluation.ts";
import publication from "../../practices/single-quote.json" with { type: "json" };
import reading from "../../practices/reading-library.json" with { type: "json" };
import { savePageCoverage } from "../fixtures/browser-coverage.ts";
import { defaultRegistry } from "../fixtures/evaluators.ts";

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

test("浏览器完成两步阅读并仅显示整篇初判和原答", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin, databasePath) => {
    const learner = await openBrowserPage(browser);
    const workspace = await openLibrary(learner, origin);
    const submitQuotes = workspace.getByRole("button", { name: "提交选据" });
    assert.equal(await submitQuotes.isDisabled(), true);
    await selectObservation(workspace);
    assert.equal(await submitQuotes.isDisabled(), true);
    await workspace.locator(".paragraph").filter({ hasText: "每晚平均有三十人" })
      .getByRole("button", { name: "选为同期条件" }).click();
    await submitQuotes.click();
    await workspace.getByRole("alert").waitFor();
    assert.match(await workspace.getByRole("alert").innerText(), /提交未确认/);
    await selectCondition(workspace);
    assert.equal(await workspace.getByRole("alert").isVisible(), false);
    await submitQuotes.click();
    await answerLibrary(workspace);
    assert.deepEqual(await workspace.locator("blockquote").allTextContents(),
      reading.material.paragraphs.slice(1, 3).map(paragraph => paragraph.text));
    await workspace.getByRole("button", { name: "交卷" }).click();
    await learner.getByText("活动已完成", { exact: true }).waitFor();
    await workspace.getByText("已交，待评", { exact: true }).waitFor();
    assert.equal(await workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" }).isDisabled(), true);
    const activityURL = learner.url();
    await learner.context().clearCookies();
    await workspace.getByRole("button", { name: "刷新成绩" }).click();
    await learner.getByRole("link", { name: "进入演示学生会话" }).waitFor();
    assert.equal(await workspace.isHidden(), true);
    assert.doesNotMatch(await learner.locator("main").innerText(), /图书馆延时开放|已交，待评|活动已完成/);
    await savePageCoverage(learner, true);
    await learner.goto(origin + "/demo/reading");
    await learner.goto(activityURL);
    await workspace.getByText("已交，待评", { exact: true }).waitFor();
    using database = new DatabaseSync(databasePath);
    evaluatePending(database, defaultRegistry);
    await workspace.getByRole("button", { name: "刷新成绩" }).click();
    await workspace.getByText("1/3", { exact: true }).waitFor();
    assert.doesNotMatch(await workspace.innerText(), /第[一二三]题[对错]|评分键/);
    await savePageCoverage(learner, true);
    await learner.reload();
    await workspace.getByText("1/3", { exact: true }).waitFor();
    assert.equal(await workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" }).isChecked(), true);
    for (const pathname of ["/reading.mjs", "/library-reading.mjs", "/reading.css", "/"]) {
      const asset = await learner.request.get(origin + pathname);
      assert.equal(asset.status(), 200);
      assert.doesNotMatch(await asset.text(), /acceptedChoices|library-key|gradingBasis/);
    }
    const privateFile = await learner.request.get(origin + "/practices/reading-library.json");
    assert.equal(privateFile.status(), 404);
    assert.deepEqual(await privateFile.json(), { code: "NOT_FOUND" });
  }, { evaluateAutomatically: false });
});

test("答题确认受阻时恢复原草稿并重试，只保留一次确认", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin, databasePath) => {
    const learner = await openBrowserPage(browser);
    const workspace = await openLibrary(learner, origin);
    await selectObservation(workspace);
    await selectCondition(workspace);
    await workspace.getByRole("button", { name: "提交选据" }).click();
    await answerLibrary(workspace);
    const confirm = workspace.getByRole("button", { name: "交卷" });
    const path = origin + "/api" + new URL(learner.url()).pathname + "/submissions";
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inputs: (string | null)[] = [];
    await learner.route(path, async route => {
      inputs.push(route.request().postData());
      if (inputs.length > 1) return route.continue();
      arrived.resolve();
      await release.promise;
      await route.abort();
    });
    await confirm.click();
    try {
      await arrived.promise;
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" }).isDisabled(), true);
    } finally {
      release.resolve();
    }
    await workspace.getByText("提交未确认，请检查选段或作答后重试。").waitFor();
    await learner.evaluate(() => {
      const key = Object.keys(sessionStorage).find(item => item.startsWith("learning-kernel:library:"));
      if (!key) throw new Error("没有已保存的答题稿");
      const stored = sessionStorage.getItem(key);
      if (!stored) throw new Error("没有可迁移的答题稿");
      sessionStorage.removeItem(key);
      sessionStorage.setItem("learning-kernel:library:" + key.split(":").at(-1), stored);
    });
    await savePageCoverage(learner, true);
    await learner.reload();
    const originalAnswer = workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" });
    await originalAnswer.waitFor();
    assert.equal(await originalAnswer.isChecked(), true);
    assert.equal(await originalAnswer.isDisabled(), true);
    await confirm.click();
    await workspace.getByText("1/3", { exact: true }).waitFor();
    assert.deepEqual(inputs, [inputs[0], inputs[0]]);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evaluation_tasks WHERE status = 'done'").get()?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 2);
  });
});

async function openLibrary(learner: Page, origin: string) {
  const response = await learner.goto(origin + "/demo/reading");
  assert.equal(response?.status(), 200);
  await learner.getByRole("button", { name: "打开活动" }).click();
  const workspace = learner.locator("#library-workspace");
  await workspace.getByRole("heading", { name: "图书馆延时开放" }).waitFor();
  return workspace;
}

function selectObservation(workspace: ReturnType<Page["locator"]>) {
  return workspace.locator(".paragraph").filter({ hasText: "每晚平均有三十人" })
    .getByRole("button", { name: "选为客流观察" }).click();
}

function selectCondition(workspace: ReturnType<Page["locator"]>) {
  return workspace.locator(".paragraph").filter({ hasText: "自习室因维修" })
    .getByRole("button", { name: "选为同期条件" }).click();
}

async function answerLibrary(workspace: ReturnType<Page["locator"]>) {
  await workspace.getByRole("heading", { name: "已交引文" }).waitFor();
  assert.equal(await workspace.getByRole("button", { name: "交卷" }).isDisabled(), true);
  await workspace.getByRole("radio", { name: "A 延时时段有人到馆" }).check();
  await workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" }).check();
  await workspace.getByRole("radio", { name: "A 立即全年延时" }).check();
}

test("双端同时交卷｜浏览器显示另一窗口的正式答卷，同时保留本窗口未交草稿", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin) => {
    const first = await openBrowserPage(browser);
    const workspace = await openLibrary(first, origin);
    await selectObservation(workspace);
    await selectCondition(workspace);
    await workspace.getByRole("button", { name: "提交选据" }).click();
    await answerLibrary(workspace);
    const other = await openBrowserPage(browser);
    await other.goto(origin + "/demo/reading");
    await other.goto(first.url());
    const otherWorkspace = other.locator("#library-workspace");
    await otherWorkspace.getByRole("heading", { name: "已交引文" }).waitFor();
    for (const [index, choice] of [1, 0, 1].entries()) {
      await otherWorkspace.locator(".reading-question").nth(index).getByRole("radio").nth(choice).check();
    }
    await workspace.getByRole("button", { name: "交卷" }).click();
    await first.getByText("活动已完成", { exact: true }).waitFor();
    await otherWorkspace.getByRole("button", { name: "交卷" }).click();
    await other.getByText("活动已完成", { exact: true }).waitFor();
    await otherWorkspace.getByRole("heading", { name: "本窗口未交出的草稿" }).waitFor();
    await otherWorkspace.getByText("B、A、B", { exact: true }).waitFor();
    const winning = otherWorkspace.getByRole("radio", { name: "B 附近自习室暂时关闭" });
    assert.equal(await winning.isChecked(), true);
    assert.equal(await winning.isDisabled(), true);
    await other.reload();
    await otherWorkspace.getByRole("heading", { name: "本窗口未交出的草稿" }).waitFor();
    assert.equal(await winning.isChecked(), true);
  });
});

test("双端同时交卷｜浏览器到达截止后禁用交卷，刷新仍保留原草稿", { timeout: 25_000 }, async t => {
  let now = Date.parse("2026-11-19T08:00:00Z");
  await withDemo(t, async (browser, origin) => {
    const learner = await openBrowserPage(browser);
    const workspace = await openLibrary(learner, origin);
    await selectObservation(workspace);
    await selectCondition(workspace);
    await workspace.getByRole("button", { name: "提交选据" }).click();
    await answerLibrary(workspace);
    now += 8 * 60_000;
    const submit = workspace.getByRole("button", { name: "交卷" });
    await submit.click();
    await workspace.getByText("已到截止，草稿已保留。", { exact: true }).waitFor();
    assert.equal(await submit.isDisabled(), true);
    await learner.reload();
    await workspace.getByText("已到截止，草稿已保留。", { exact: true }).waitFor();
    assert.equal(await workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" }).isChecked(), true);
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await learner.getByText("活动已完成", { exact: true }).count(), 0);
  }, { clock: () => new Date(now) });
});

test("撤权后重新读取｜学生页面随复盘开关闭合逐题反馈，整篇成绩保持 2/3", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin, databasePath) => {
    const learner = await openBrowserPage(browser);
    const workspace = await openLibrary(learner, origin);
    await selectObservation(workspace);
    await selectCondition(workspace);
    await workspace.getByRole("button", { name: "提交选据" }).click();
    await answerLibrary(workspace);
    await workspace.getByRole("button", { name: "交卷" }).click();
    await workspace.getByText("已交，待评", { exact: true }).waitFor();
    const pathname = new URL(learner.url()).pathname;
    const activityId = pathname.split("/").at(-1);
    const data = await learner.request.get(origin + "/api" + pathname);
    assert.equal(data.status(), 200);
    const { submission } = z.object({ submission: z.object({ receipt: z.object({ id: z.uuid() }) }) }).parse(await data.json());
    using database = new DatabaseSync(databasePath);
    evaluatePending(database, defaultRegistry);
    const teacherPost = async (path: string, payload: Record<string, unknown>) => {
      const response = await fetch(origin + path, {
        method: "POST",
        headers: { cookie: "learning_session=browser-teacher", "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, ...payload }),
      });
      assert.equal(response.status, 200, await response.text());
    };
    await teacherPost(`/api/reviews/${activityId}/verdicts`, {
      submissionId: submission.receipt.id, questionId: "q2", targetId: "interpret",
      action: "override", operationId: "browser-revise", expectedRevision: 0, correct: true, reason: "具体条件支持作答",
    });
    await teacherPost(`/api/reviews/${activityId}`, { text: "说明同期条件对推断的影响。" });
    await teacherPost(`/api/manage/${activityId}`, { action: "openReview" });
    await savePageCoverage(learner, true);
    await learner.reload();
    await workspace.getByText("2/3", { exact: true }).waitFor();
    const verdict = workspace.locator(".reading-question").nth(1).getByText("判定正确", { exact: true });
    await verdict.waitFor();
    await workspace.getByText("说明同期条件对推断的影响。", { exact: true }).waitFor();
    await teacherPost(`/api/manage/${activityId}`, { action: "closeReview" });
    await savePageCoverage(learner, true);
    await learner.reload();
    await workspace.getByText("2/3", { exact: true }).waitFor();
    assert.equal(await verdict.count(), 0);
    assert.equal(await workspace.getByText("说明同期条件对推断的影响。", { exact: true }).count(), 0);
    assert.equal(await workspace.getByRole("radio", { name: "B 附近自习室暂时关闭" }).isChecked(), true);
  }, { evaluateAutomatically: false, reviewerSessions: new Map([["browser-teacher", "teacher-1"]]) });
});

test("撤权后重新读取｜浏览器获知学生记录权限收回后清除旧视图与活动缓存", { timeout: 25_000 }, async t => {
  await withDemo(t, async (browser, origin) => {
    const learner = await openBrowserPage(browser);
    const workspace = await openLibrary(learner, origin);
    await selectObservation(workspace);
    await selectCondition(workspace);
    await workspace.getByRole("button", { name: "提交选据" }).click();
    await answerLibrary(workspace);
    const pathname = new URL(learner.url()).pathname;
    await learner.route(origin + "/api" + pathname + "/submissions", route => route.abort());
    await workspace.getByRole("button", { name: "交卷" }).click();
    await workspace.getByText("提交未确认，请检查选段或作答后重试。").waitFor();
    const cached = () => learner.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("learning-kernel:library:")));
    assert.equal((await cached()).length, 1);
    const activityId = pathname.split("/").at(-1);
    const revoked = await fetch(origin + `/api/manage/${activityId}`, {
      method: "POST",
      headers: { cookie: "learning_session=browser-teacher", "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, action: "revokeStudent" }),
    });
    assert.equal(revoked.status, 200, await revoked.text());
    await learner.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await learner.getByText("当前账号无权查看此活动。").waitFor();
    assert.equal(await workspace.isHidden(), true);
    assert.doesNotMatch(await learner.locator("main").innerText(), /图书馆延时开放|附近自习室暂时关闭/);
    assert.deepEqual(await cached(), []);
    await savePageCoverage(learner, true);
    await learner.reload();
    await learner.getByText("当前账号无权查看此活动。").waitFor();
  }, { reviewerSessions: new Map([["browser-teacher", "teacher-1"]]) });
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

async function withDemo(
  t: TestContext, run: (browser: Browser, origin: string, databasePath: string) => Promise<void>,
  options?: Parameters<typeof createDemoServer>[1],
) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "test.sqlite");
  const server = createDemoServer(databasePath, options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch();
    try {
      await run(browser, `http://127.0.0.1:${address.port}`, databasePath);
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
