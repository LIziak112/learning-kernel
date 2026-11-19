import { strict as assert } from "node:assert";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Browser, Locator } from "playwright";
import { z } from "zod";
import { startReceipt, submissionReceipt } from "../src/contracts/reading.ts";
import { readingAnswerDraft, readingDraftReceipt, readingSelection } from "../src/contracts/reading-runtime.ts";
import { createDemoServer } from "../src/host/demo.ts";
import { savePageCoverage } from "./fixtures/browser-coverage.ts";
import { buildRuntime } from "./fixtures/built-runtime.ts";
import { contrastA, contrastB, contrastC } from "./fixtures/reading-contrasts.ts";
import {
  answerSubmission, countFacts, firstChoices, firstClock, get, post, prepareAnswers, prepareScenario, readingState,
  rejection, result, scenarioDatabase, selectionRanges, withScenarioServer,
} from "./fixtures/online-reading.ts";

let runtime: Awaited<ReturnType<typeof buildRuntime>>;
before(async () => { runtime = await buildRuntime(); });
after(() => runtime?.finish());

function withRuntime<T>(file: string, options: Parameters<typeof withScenarioServer>[1], run: (origin: string) => Promise<T>) {
  return withScenarioServer(file, options, run, runtime.server);
}

test("声明对照 A｜更换标识与题数后仍裁决争交、改判和撤销", async t => {
  const file = scenarioDatabase(t);
  const original = await withRuntime(file, { evaluateAutomatically: true }, async origin => {
    const scenario = await prepareScenario(origin);
    const saved = await prepareAnswers(origin, scenario, firstChoices, "original-answers");
    await result(post(origin, scenario.path + "/submissions", saved), submissionReceipt);
    await assertScore(origin, scenario.path, 1, 3);
    return scenario.path;
  });
  await withRuntime(file, { additionalPublications: [contrastA], evaluateAutomatically: true }, async origin => {
    const start = await begin(origin, contrastA.practice.id, "contrast-a");
    const path = "/api/activities/" + start.activityId;
    const quote = await submitSelection(origin, path, { stepAttemptId: start.stepAttemptId, slotId: "excerpts" });
    const step = await result(get(origin, path), readingState);
    const binding = { stepAttemptId: step.stepAttemptId, slotId: "response" };
    const draft = await saveAnswer(origin, path, binding, { q1: "A", q2: "B" }, { support: quote.receipt.id });
    const submissions = await Promise.all([
      post(origin, path + "/submissions", { ...binding, draft, operationId: "first-window" }),
      post(origin, path + "/submissions", { ...binding, draft, operationId: "second-window" }, "window-b"),
    ]);
    assert.deepEqual(submissions.map(response => response.status).sort(), [200, 409]);
    const winner = submissions.find(response => response.ok);
    const loser = submissions.find(response => !response.ok);
    assert.ok(winner && loser);
    assert.deepEqual(await loser.json(), { code: "ALREADY_SUBMITTED" });
    const receipt = submissionReceipt.parse(await winner.json());
    await assertScore(origin, path, 1, 2);
    const review = `/api/reviews/${start.activityId}/verdicts`;
    const location = { submissionId: receipt.id, questionId: "q2", targetId: "interpret" };
    const command = { ...location, action: "override", correct: true, expectedRevision: 0, reason: "已核对原选项", operationId: "revise" };
    const revised = await result(post(origin, review, command, "teacher"), z.object({ id: z.uuid(), revision: z.literal(1) }));
    await assertScore(origin, path, 2, 2);
    await result(post(origin, review, {
      ...location, action: "withdraw", withdrawId: revised.id, expectedRevision: 1, reason: "复核后撤销", operationId: "withdraw",
    }, "teacher"), z.object({ revision: z.literal(2) }));
    await assertScore(origin, path, 1, 2);
    await assertScore(origin, original, 1, 3);
    using database = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(countFacts(database), { submissions: 4, selections: 2, answers: 5, completions: 2, tasks: 2, verdicts: 5 });
  });
});

test("声明对照 B｜只选据即完成，重开后无待评也无成绩", async t => {
  const file = scenarioDatabase(t);
  const practiceId = contrastB.practice.id;
  const started = await withRuntime(file, { publication: contrastB }, async origin => {
    const start = await begin(origin, practiceId, "only-evidence");
    const path = "/api/activities/" + start.activityId;
    const binding = { stepAttemptId: start.stepAttemptId, slotId: "quotes" };
    return { path, ...await submitSelection(origin, path, binding) };
  });
  await withRuntime(file, { publication: contrastB }, async origin => {
    const completed = await result(get(origin, started.path), z.object({
      status: z.literal("completed"),
      submission: z.strictObject({ receipt: submissionReceipt, selection: readingSelection }),
    }).passthrough());
    assert.deepEqual(completed.submission, { receipt: started.receipt, selection: started.selection });
    assert.equal(completed.assessment, undefined);
    assert.equal(completed.review, undefined);
    using database = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(countFacts(database), { submissions: 1, selections: 1, answers: 0, completions: 1, tasks: 0, verdicts: 0 });
  });
});

test("声明对照 C｜两次作答跨重开各自保留，活动不计时也不评分", async t => {
  const file = scenarioDatabase(t);
  let now = firstClock;
  const options = { publication: contrastC, clock: () => new Date(now) };
  const first = await withRuntime(file, options, async origin => {
    const start = await begin(origin, contrastC.practice.id, "contrast-c");
    const path = "/api/activities/" + start.activityId;
    const binding = { stepAttemptId: start.stepAttemptId, slotId: "original" };
    const draft = await saveAnswer(origin, path, binding, { q1: "A" }, {});
    const receipt = await result(post(origin, path + "/submissions", { ...binding, draft, operationId: "first-answer" }), submissionReceipt);
    return { path, start, receipt };
  });
  now += 10 * 60_000;
  const second = await withRuntime(file, options, async origin => {
    const active = await result(get(origin, first.path), readingState.extend({
      inputs: z.object({ original: answerSubmission }), step: z.object({ id: z.literal("second-answer") }),
    }));
    assert.equal(active.status, "active");
    assert.equal(active.material, undefined);
    assert.deepEqual(active.inputs.original, { receipt: first.receipt, answer: { choices: { q1: "A" }, references: {} } });
    const binding = { stepAttemptId: active.stepAttemptId, slotId: "revised" };
    const draft = await saveAnswer(origin, first.path, binding, { q1: "B" }, { previous: first.receipt.id });
    const receipt = await result(post(origin, first.path + "/submissions", { ...binding, draft, operationId: "second-answer" }), submissionReceipt);
    assert.notEqual(receipt.id, first.receipt.id);
    return receipt;
  });
  await withRuntime(file, options, async origin => {
    const completed = await result(get(origin, first.path), readingState);
    assert.equal(completed.status, "completed");
    assert.equal(completed.assessment, undefined);
    assert.equal(completed.review, undefined);
    assert.deepEqual(completed.submission?.receipt, second);
    assert.deepEqual(completed.submission?.answer.choices, { q1: "B" });
    for (const [receipt, answer] of [[first.receipt, "A"], [second, "B"]] as const) {
      const detail = await result(get(origin, first.path + "/submissions/" + receipt.id), answerSubmission);
      assert.deepEqual(detail.receipt, receipt);
      assert.deepEqual(detail.answer.choices, { q1: answer });
    }
    await rejection(get(origin, first.path + "/review"), 403, "FORBIDDEN");
    using database = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(countFacts(database), { submissions: 2, selections: 0, answers: 2, completions: 1, tasks: 0, verdicts: 0 });
  });
});

test("浏览器链路｜学生提交、教师改判、学生按当前权限回看", { timeout: 25_000 }, async t => {
  await withDemoBrowser(scenarioDatabase(t), async (browser, origin) => {
    await browserReviewFlow(browser, origin, "/demo/reading", ["A", "B", "A"], 3);
  }, undefined, createDemoServer);
});

test("声明对照 A｜运行产物的师生网页对两题改判、开关复盘并回看", { timeout: 25_000 }, async t => {
  await withDemoBrowser(scenarioDatabase(t), async (browser, origin) => {
    await browserReviewFlow(browser, origin, contrastEntry(contrastA.practice.id), ["A", "B"], 2);
  }, { additionalPublications: [contrastA] });
});

test("声明对照 B｜运行产物的师生网页只读选据和回执", { timeout: 25_000 }, async t => {
  await withDemoBrowser(scenarioDatabase(t), async (browser, origin) => {
    const { learner, workspace } = await startBrowserActivity(browser, origin, contrastEntry(contrastB.practice.id));
    await chooseQuotes(workspace);
    await learner.getByText("活动已完成", { exact: true }).waitFor();
    const ownReceipt = await workspace.getByText(/^提交回执 /).innerText();
    await savePageCoverage(learner, true);
    await learner.reload();
    await workspace.getByText(ownReceipt, { exact: true }).waitFor();
    assert.equal(await workspace.getByRole("radio").count(), 0);
    assert.doesNotMatch(await workspace.innerText(), /待评|刷新成绩|\d\/\d/);
    const teacher = await openTeacher(browser, origin, learner.url());
    await teacher.getByText(ownReceipt, { exact: true }).waitFor();
    await teacher.getByText(/每晚平均有三十人到馆/).waitFor();
    assert.equal(await teacher.getByRole("button", { name: "开放复盘" }).count(), 0);
    assert.equal(await teacher.getByRole("heading", { name: "评阅", exact: true }).count(), 0);
  }, { additionalPublications: [contrastB] });
});

test("声明对照 C｜运行产物的师生网页分别回看 A 和 B 两次作答", { timeout: 25_000 }, async t => {
  await withDemoBrowser(scenarioDatabase(t), async (browser, origin) => {
    const { learner, workspace } = await startBrowserActivity(browser, origin, contrastEntry(contrastC.practice.id));
    await chooseAnswers(workspace, ["A"]);
    const original = workspace.getByText("已交作答 A", { exact: true });
    await original.waitFor();
    await savePageCoverage(learner, true);
    await learner.reload();
    await original.waitFor();
    await chooseAnswers(workspace, ["B"]);
    await learner.getByText("活动已完成", { exact: true }).waitFor();
    const answerB = workspace.getByRole("radio", { name: /^B / });
    assert.equal(await answerB.isChecked(), true);
    assert.equal(await answerB.isDisabled(), true);
    await original.waitFor();
    assert.doesNotMatch(await workspace.innerText(), /待评|刷新成绩|图书馆延时开放/);
    const teacher = await openTeacher(browser, origin, learner.url());
    await teacher.getByText("A", { exact: true }).waitFor();
    await teacher.getByText("B", { exact: true }).waitFor();
    assert.equal(await teacher.getByText(/^提交回执 /).count(), 2);
  }, { additionalPublications: [contrastC] });
});

function contrastEntry(id: string) {
  return "/demo/reading?" + new URLSearchParams({ practice: id });
}

async function withDemoBrowser(
  file: string, run: (browser: Browser, origin: string) => Promise<void>,
  options?: Parameters<typeof createDemoServer>[1], factory = runtime.demo,
) {
  const server = factory(file, options);
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch();
    try {
      await run(browser, `http://127.0.0.1:${address.port}`);
    } finally {
      try {
        for (const context of browser.contexts()) for (const page of context.pages()) await savePageCoverage(page);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function browserPage(browser: Browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  if (process.env.NODE_V8_COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
  return page;
}

async function startBrowserActivity(browser: Browser, origin: string, entry: string) {
  const learner = await browserPage(browser);
  const loaded = await learner.goto(origin + entry);
  assert.equal(loaded?.status(), 200);
  await learner.getByRole("button", { name: "打开活动" }).click();
  return { learner, workspace: learner.locator("#library-workspace") };
}

async function chooseQuotes(workspace: Locator) {
  await workspace.locator(".paragraph").filter({ hasText: "每晚平均有三十人" }).getByRole("button", { name: "选为客流观察" }).click();
  await workspace.locator(".paragraph").filter({ hasText: "自习室因维修" }).getByRole("button", { name: "选为同期条件" }).click();
  await workspace.getByRole("button", { name: "提交选据" }).click();
}

async function chooseAnswers(workspace: Locator, options: string[]) {
  for (const [index, option] of options.entries()) {
    await workspace.locator(".reading-question").nth(index).getByRole("radio", { name: new RegExp(`^${option} `) }).check();
  }
  await workspace.getByRole("button", { name: "交卷" }).click();
}

async function browserReviewFlow(browser: Browser, origin: string, entry: string, answers: string[], questionCount: number) {
  const { learner, workspace } = await startBrowserActivity(browser, origin, entry);
  await chooseQuotes(workspace);
  await workspace.getByRole("heading", { name: "已交引文" }).waitFor();
  const teacher = await openTeacher(browser, origin, learner.url());
  await teacher.getByRole("button", { name: "开放复盘" }).waitFor();
  assert.equal(await teacher.locator("[data-question]").count(), 0);
  await chooseAnswers(workspace, answers);
  const initialScore = workspace.getByText(`1/${questionCount}`, { exact: true });
  const refresh = workspace.getByRole("button", { name: "刷新成绩" });
  await initialScore.or(refresh).waitFor();
  if (await refresh.isVisible()) await refresh.click();
  await initialScore.waitFor();
  await savePageCoverage(teacher, true);
  await teacher.reload();
  const activityId = new URL(learner.url()).pathname.split("/").at(-1);
  const second = teacher.locator('[data-question="q2"]');
  await second.getByText("修订 0", { exact: true }).waitFor();
  await second.getByLabel("评阅理由").fill("同期条件支持所选解释");
  const override = second.getByRole("button", { name: "判对" });
  await teacher.route(origin + "/api/reviews/" + activityId + "/verdicts", async route => {
    const confirmed = await route.fetch();
    assert.equal(confirmed.status(), 200);
    await route.abort();
  }, { times: 1 });
  await override.click();
  await teacher.getByText("评阅请求未确认，请重试。", { exact: true }).waitFor();
  await override.click();
  await second.getByText("修订 1", { exact: true }).waitFor();
  await savePageCoverage(teacher, true);
  await teacher.reload();
  await second.getByText("修订 1", { exact: true }).waitFor();
  await teacher.getByRole("button", { name: "开放复盘" }).click();
  await teacher.getByText("复盘已开放", { exact: true }).waitFor();
  await savePageCoverage(learner, true);
  await learner.reload();
  await workspace.getByText(`2/${questionCount}`, { exact: true }).waitFor();
  const feedback = workspace.locator(".reading-question").nth(1).getByText("判定正确", { exact: true });
  await feedback.waitFor();
  await teacher.getByRole("button", { name: "关闭复盘" }).click();
  await teacher.getByText("复盘已关闭", { exact: true }).waitFor();
  await savePageCoverage(learner, true);
  await learner.reload();
  await workspace.getByText(`2/${questionCount}`, { exact: true }).waitFor();
  assert.equal(await feedback.count(), 0);
  await second.getByLabel("评阅理由").fill("撤销本轮调整");
  await second.getByRole("button", { name: "撤销改判" }).click();
  await second.getByText("修订 2", { exact: true }).waitFor();
  await learner.reload();
  await workspace.getByText(`1/${questionCount}`, { exact: true }).waitFor();
  const forbidden = await learner.request.get(origin + "/api/manage/" + activityId);
  assert.equal(forbidden.status(), 403);
  assert.deepEqual(await forbidden.json(), { code: "FORBIDDEN" });
  const revoked = await teacher.request.post(origin + "/api/manage/" + activityId, {
    data: { protocolVersion: 1, action: "revokeReviewer" },
  });
  assert.equal(revoked.status(), 200);
  const managed = await teacher.request.get(origin + "/api/manage/" + activityId);
  assert.equal(managed.status(), 200);
  assert.deepEqual(await managed.json(), { reviewOpen: false, canToggleReview: true, reviewerActions: [] });
  await savePageCoverage(teacher, true);
  await teacher.reload();
  await teacher.getByText("当前会话无权查看此评阅。", { exact: true }).waitFor();
  assert.equal(await teacher.locator("#teacher-workspace").isHidden(), true);
  for (const asset of ["/teacher.mjs", "/api.mjs", "/review"]) {
    const response = await teacher.request.get(origin + asset);
    assert.equal(response.status(), 200);
    assert.doesNotMatch(await response.text(), /acceptedChoices|library-key|keyRef/);
  }
}

async function openTeacher(browser: Browser, origin: string, activityUrl: string) {
  const teacher = await browserPage(browser);
  const login = await teacher.goto(origin + "/demo/teacher");
  assert.equal(login?.status(), 200);
  const lookup = teacher.getByLabel("活动链接或编号");
  await lookup.fill("无效链接");
  await teacher.getByRole("button", { name: "打开评阅" }).click();
  await teacher.getByText("请输入学生的活动链接或编号。", { exact: true }).waitFor();
  await lookup.fill(activityUrl);
  await teacher.getByRole("button", { name: "打开评阅" }).click();
  await teacher.getByRole("heading", { name: "学生提交" }).waitFor();
  return teacher;
}

function begin(origin: string, practiceId: string, operationId: string) {
  return result(post(origin, "/api/activities", { practiceId, operationId }), startReceipt);
}

type Binding = { stepAttemptId: string; slotId: string };

async function submitSelection(origin: string, path: string, binding: Binding) {
  const saved = await result(post(origin, path + "/drafts", { ...binding, ranges: selectionRanges }), readingDraftReceipt);
  const receipt = await result(post(origin, path + "/submissions", {
    ...binding, draft: saved.draft, operationId: "select-excerpts",
  }), submissionReceipt);
  return { receipt, selection: saved.selection };
}

async function saveAnswer(
  origin: string, path: string, binding: Binding, choices: Record<string, string>, references: Record<string, string>,
) {
  return (await result(post(origin, path + "/drafts", { ...binding, choices, references }), readingAnswerDraft)).draft;
}

async function assertScore(origin: string, path: string, correctCount: number, questionCount: number) {
  for (let tryCount = 0; tryCount < 40; tryCount++) {
    const state = await result(get(origin, path), readingState);
    if (state.assessment?.status === "complete") {
      assert.deepEqual(state.assessment, { status: "complete", correctCount, questionCount });
      return;
    }
    await delay(25);
  }
  throw new Error("运行产物未在一秒内交付整篇结果");
}
