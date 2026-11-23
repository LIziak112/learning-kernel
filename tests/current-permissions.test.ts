import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { startReceipt, submissionReceipt } from "../src/contracts/reading.ts";
import { evaluatePending } from "../src/kernel/pending-evaluation.ts";
import { defaultRegistry } from "./fixtures/evaluators.ts";
import {
  countFacts, firstChoices, firstClock, get, post, prepareAnswers, prepareScenario, readingState, rejection, result,
  scenarioDatabase, secondChoices, withScenarioServer,
} from "./fixtures/online-reading.ts";

const passageScore = { status: "complete", correctCount: 2, questionCount: 3 };
const toggled = z.strictObject({ reviewOpen: z.boolean() });
const reviewDisplay = z.strictObject({
  byQuestion: z.array(z.strictObject({ questionId: z.string(), correct: z.boolean() })).optional(),
  selectionFeedback: z.string().optional(),
});
const exportView = z.strictObject({
  activityId: z.uuid(), status: z.literal("completed"),
  submissions: z.array(z.unknown()), assessment: z.unknown(), review: reviewDisplay.optional(),
});
const historyView = z.strictObject({ verdicts: z.array(z.unknown()), automaticVerdicts: z.array(z.unknown()) });
const feedback = "核对引文所处的同期条件。";

test("撤权后重新读取｜复盘开关统一约束详情、整篇统计、专用读取和导出", async t => {
  const file = scenarioDatabase(t);
  await withScenarioServer(file, {}, async origin => {
    using database = new DatabaseSync(file);
    const { scenario, receipt, parent, manage, verdict } = await completedReview(origin, database);
    const learner = scenario.path;
    const details = await result(get(origin, learner), readingState);
    assert.deepEqual(details.assessment, passageScore);
    assert.equal(details.review, undefined);
    await rejection(get(origin, learner + "/review"), 403, "FORBIDDEN");
    await rejection(post(origin, manage, { action: "openReview" }), 403, "FORBIDDEN");
    await rejection(post(origin, manage, { action: "openReview" }, "other-teacher"), 403, "FORBIDDEN");
    assert.deepEqual(await result(post(origin, manage, { action: "openReview" }, "teacher"), toggled), { reviewOpen: true });
    const open = await result(get(origin, learner), readingState.extend({ review: reviewDisplay }));
    const exported = await result(get(origin, learner + "/export"), exportView);
    assert.deepEqual(open.assessment, passageScore);
    assert.deepEqual(exported.assessment, passageScore);
    assert.deepEqual(open.review, {
      byQuestion: [{ questionId: "q1", correct: true }, { questionId: "q2", correct: true }, { questionId: "q3", correct: false }],
      selectionFeedback: feedback,
    });
    assert.deepEqual(await result(get(origin, learner + "/review"), reviewDisplay), open.review);
    await rejection(get(origin, learner + "/assessment?questionId=q2"), 403, "FORBIDDEN");
    assert.deepEqual(exported.review, open.review);
    assert.equal(exported.submissions.length, 2);
    assert.deepEqual(exported.submissions[1], { receipt, answer: open.submission?.answer });
    assert.doesNotMatch(JSON.stringify(exported), /acceptedChoices|gradingBasis|同期条件足以支持|reviewerId/);
    const history = await result(get(origin, parent + "/history", "teacher"), historyView);
    assert.match(JSON.stringify(history), new RegExp(verdict.id));
    const teacherExport = await result(get(origin, parent + "/export", "teacher"), z.object({ submissions: z.array(z.unknown()) }));
    assert.deepEqual(teacherExport.submissions, exported.submissions);
    const teacherSubmission = await result(get(origin, parent + "/submissions/" + receipt.id, "teacher"), z.unknown());
    assert.deepEqual(teacherSubmission, exported.submissions[1]);
    const quote = await result(get(origin, parent + "/fragments/" + scenario.quote.id, "teacher"), z.object({ ranges: z.array(z.unknown()) }));
    assert.equal(quote.ranges.length, 2);
    assert.deepEqual(await result(get(origin, learner + "/fragments/" + scenario.quote.id), z.object({ ranges: z.array(z.unknown()) })), quote);
    await rejection(get(origin, parent + "/fragments/" + receipt.id, "teacher"), 403, "FORBIDDEN");
    await rejection(get(origin, learner + "/fragments/" + scenario.quote.id, "other"), 403, "FORBIDDEN");
    await rejection(get(origin, parent + "/fragments/" + scenario.quote.id, "other-teacher"), 403, "FORBIDDEN");

    assert.deepEqual(await result(post(origin, manage, { action: "closeReview" }, "teacher"), toggled), { reviewOpen: false });
    const closed = await result(get(origin, learner), readingState);
    const closedExport = await result(get(origin, learner + "/export"), exportView);
    const aggregate = await result(get(origin, learner + "/assessment"), z.strictObject({ assessment: z.unknown() }));
    assert.deepEqual(closedExport.assessment, passageScore);
    assert.deepEqual(closed.assessment, closedExport.assessment);
    assert.deepEqual(aggregate.assessment, closedExport.assessment);
    assert.equal(closed.review, undefined);
    assert.equal(closedExport.review, undefined);
    assert.deepEqual(closedExport.submissions, exported.submissions);
    assert.doesNotMatch(JSON.stringify([closed, closedExport]), /"correct"|selectionFeedback|acceptedChoices|verdicts/);
    for (const suffix of ["/review", "/assessment?questionId=q2", "/assessment/q2", "/export?question=q2"]) {
      await rejection(get(origin, learner + suffix), 403, "FORBIDDEN");
    }
    assert.deepEqual(await result(get(origin, parent + "/history", "teacher"), historyView), history);
  });
});

test("撤权后重新读取｜未布置评阅者也能读取整篇结果", async t => {
  const file = scenarioDatabase(t);
  await withScenarioServer(file, { assignedReviewer: undefined }, async origin => {
    const scenario = await prepareScenario(origin);
    const turnIn = await prepareAnswers(origin, scenario, firstChoices, "turn-a");
    await result(post(origin, scenario.path + "/submissions", turnIn), submissionReceipt);
    using database = new DatabaseSync(file);
    evaluatePending(database, defaultRegistry);
    const delivered = await result(get(origin, scenario.path), readingState);
    assert.deepEqual(delivered.assessment, { status: "complete", correctCount: 1, questionCount: 3 });
    assert.equal(delivered.review, undefined);
    await rejection(get(origin, scenario.path + "/review"), 403, "FORBIDDEN");
  });
});

for (const [label, questionAllowed, quotesAllowed] of [
  ["仅选据评语", false, true], ["仅逐题反馈", true, false], ["无可读字段", false, false],
] as const) {
  test(`撤权后重新读取｜复盘开放也需评估齐备并服从字段声明（${label}）`, async t => {
    const file = scenarioDatabase(t);
    const publication = structuredClone(reading);
    publication.practice.policy.student.review.byQuestion = questionAllowed ? ["effectiveVerdict"] : [];
    publication.practice.policy.student.review.byQuoteSet = quotesAllowed ? ["learnerFeedback"] : [];
    await withScenarioServer(file, { publication }, async origin => {
      const scenario = await prepareScenario(origin);
      const turnIn = await prepareAnswers(origin, scenario, firstChoices, "turn-a");
      await result(post(origin, scenario.path + "/submissions", turnIn), submissionReceipt);
      const parent = `/api/reviews/${scenario.start.activityId}`;
      await result(post(origin, parent, { text: feedback }, "teacher"), z.unknown());
      await result(post(origin, `/api/manage/${scenario.start.activityId}`, { action: "openReview" }, "teacher"), toggled);
      const review = scenario.path + "/review";
      await rejection(get(origin, review), 403, "FORBIDDEN");
      const waiting = await result(get(origin, scenario.path), readingState);
      assert.deepEqual(waiting.assessment, { status: "pending" });
      assert.equal(waiting.review, undefined);
      using database = new DatabaseSync(file);
      evaluatePending(database, defaultRegistry);
      if (!questionAllowed && !quotesAllowed) {
        await rejection(get(origin, review), 403, "FORBIDDEN");
      } else {
        const permitted = await result(get(origin, review), reviewDisplay);
        assert.equal(permitted.byQuestion?.length, questionAllowed ? 3 : undefined);
        assert.equal(permitted.selectionFeedback, quotesAllowed ? feedback : undefined);
      }
    });
  });
}

async function completedReview(origin: string, database: DatabaseSync) {
  const scenario = await prepareScenario(origin);
  const input = await prepareAnswers(origin, scenario, firstChoices, "turn-a");
  const receipt = await result(post(origin, scenario.path + "/submissions", input), submissionReceipt);
  evaluatePending(database, defaultRegistry);
  const parent = `/api/reviews/${scenario.start.activityId}`;
  const manage = `/api/manage/${scenario.start.activityId}`;
  const command = {
    submissionId: receipt.id, targetId: "interpret", questionId: "q2", action: "override",
    operationId: "revise", expectedRevision: 0, reason: "同期条件足以支持", correct: true,
  };
  const verdict = await result(post(origin, parent + "/verdicts", command, "teacher"), z.object({ id: z.uuid() }));
  await result(post(origin, parent, { text: feedback }, "teacher"), z.strictObject({ selectionFeedback: z.string() }));
  return { scenario, input, receipt, parent, manage, command, verdict };
}

test("撤权后重新读取｜评阅者旧链接、条件请求和改判重放受到撤权", async t => {
  const file = scenarioDatabase(t);
  const source = await withScenarioServer(file, {}, async origin => {
    using database = new DatabaseSync(file);
    const ready = await completedReview(origin, database);
    const { scenario, receipt, parent, manage, command } = ready;
    await result(post(origin, manage, { action: "openReview" }, "teacher"), toggled);
    const fragment = parent + "/fragments/" + scenario.quote.id;
    assert.equal((await get(origin, fragment, "teacher")).status, 200);
    await rejection(post(origin, manage, { action: "revokeReviewer" }, "other-teacher"), 403, "FORBIDDEN");
    assert.deepEqual(await result(post(origin, manage, { action: "revokeReviewer" }, "teacher"),
      z.strictObject({ reviewerActive: z.literal(false) })), { reviewerActive: false });

    for (const path of [parent, fragment, parent + "/history", parent + "/export", parent + "/submissions/" + receipt.id]) {
      await rejection(conditionalRead(origin, path, "teacher"), 403, "FORBIDDEN");
    }
    await rejection(post(origin, parent + "/verdicts", command, "teacher"), 403, "FORBIDDEN");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM verdict_events").get()?.count, 1);
    const student = await result(get(origin, scenario.path), readingState);
    assert.deepEqual(student.assessment, passageScore);
    assert.ok(student.review);
    assert.deepEqual(await result(post(origin, manage, { action: "closeReview" }, "teacher"), toggled), { reviewOpen: false });
    return { fragment, parent };
  });
  await withScenarioServer(file, {}, async origin => {
    await rejection(conditionalRead(origin, source.fragment, "teacher"), 403, "FORBIDDEN");
    await rejection(conditionalRead(origin, source.parent + "/history", "teacher"), 403, "FORBIDDEN");
  });
});

function conditionalRead(origin: string, path: string, session: string) {
  return fetch(origin + path, {
    headers: {
      cookie: `learning_session=${session}`,
      "if-none-match": "*",
      "if-modified-since": "Thu, 19 Nov 2026 08:00:00 GMT",
    },
    signal: AbortSignal.timeout(8000),
  });
}

for (const scope of ["closeReview", "revokeReviewer", "revokeStudent"] as const) {
  test(`撤权后重新读取｜在途条件请求按交付时的 ${scope} 裁决`, async t => {
    const file = scenarioDatabase(t);
    let pausedPath: string | undefined;
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const options = {
      evaluateAutomatically: false,
      async beforeDelivery(path: string) {
        if (path !== pausedPath) return;
        reached.resolve();
        await resume.promise;
      },
    };
    await withScenarioServer(file, options, async origin => {
      using database = new DatabaseSync(file);
      const { manage, parent, scenario } = await completedReview(origin, database);
      await result(post(origin, manage, { action: "openReview" }, "teacher"), toggled);
      const paths = {
        closeReview: [scenario.path + "/review", "window-a"],
        revokeReviewer: [parent + "/fragments/" + scenario.quote.id, "teacher"],
        revokeStudent: [scenario.path + "/export", "window-a"],
      } as const;
      const [path, session] = paths[scope];
      const prior = await get(origin, path, session);
      assert.equal(prior.status, 200);
      assert.equal(prior.headers.get("cache-control"), "no-store");
      assert.ok((await prior.text()).length > 15);

      pausedPath = path;
      const request = conditionalRead(origin, path, session);
      try {
        await Promise.race([reached.promise, request.then(() => { throw new Error("读取未在交付前暂停"); })]);
        await result(post(origin, manage, { action: scope }, "teacher"), z.unknown());
      } finally {
        resume.resolve();
      }
      await rejection(request, 403, "FORBIDDEN");
      await rejection(conditionalRead(origin, path, session), 403, "FORBIDDEN");
    });
  });
}

test("撤权后重新读取｜学生旧记录与回执失效，自有稿及教师历史仍可读", async t => {
  const file = scenarioDatabase(t);
  await withScenarioServer(file, {}, async origin => {
    using database = new DatabaseSync(file);
    const { scenario, receipt, parent, manage, input } = await completedReview(origin, database);
    await result(post(origin, manage, { action: "openReview" }, "teacher"), toggled);
    const ownDraft = await prepareAnswers(origin, scenario, secondChoices, "private-draft");
    const draftPath = "/api/drafts/" + ownDraft.draft.id;
    const records = [
      scenario.path, scenario.path + "/assessment", scenario.path + "/review", scenario.path + "/export",
      scenario.path + "/submissions/" + receipt.id, scenario.path + "/fragments/" + scenario.quote.id,
    ];
    for (const path of records) {
      const before = await get(origin, path);
      assert.equal(before.status, 200);
      await before.text();
    }
    const before = countFacts(database);
    assert.deepEqual(await result(post(origin, manage, { action: "revokeStudent" }, "teacher"),
      z.strictObject({ studentActive: z.literal(false) })), { studentActive: false });
    for (const path of records) await rejection(conditionalRead(origin, path, "window-a"), 403, "FORBIDDEN");
    await rejection(post(origin, scenario.path + "/submissions", input), 403, "FORBIDDEN");
    await rejection(post(origin, "/api/activities", { operationId: "start", practiceId: "reading-library" }), 403, "FORBIDDEN");
    await rejection(post(origin, scenario.path + "/drafts", {
      ...scenario.binding, choices: firstChoices, references: { basis: scenario.quote.id },
    }), 403, "FORBIDDEN");
    const allowed = await result(get(origin, draftPath), z.unknown());
    assert.deepEqual(allowed, { draft: ownDraft.draft, content: { choices: secondChoices } });
    await rejection(get(origin, draftPath, "other"), 403, "FORBIDDEN");
    const quoteWork = database.prepare("SELECT work_id FROM submissions WHERE id = ?").get(scenario.quote.id)?.work_id;
    assert.equal(typeof quoteWork, "string");
    const privateQuote = await result(get(origin, "/api/drafts/" + String(quoteWork)), z.strictObject({
      draft: z.object({ id: z.uuid(), version: z.int() }),
      content: z.strictObject({ ranges: z.array(z.strictObject({
        role: z.string(), paragraphId: z.string(), start: z.int(), end: z.int(),
      })) }),
    }));
    assert.deepEqual(privateQuote.content.ranges.map(range => [range.role, range.paragraphId]), [
      ["observation", "p2"], ["condition", "p3"],
    ]);
    const previous = await result(get(origin, parent + "/history", "teacher"), historyView);
    assert.equal(previous.verdicts.length, 3);
    assert.deepEqual(countFacts(database), before);
  });
});

test("撤权后重新读取｜授权重练只创建关联新实例，原记录和回执仍可读", async t => {
  const file = scenarioDatabase(t);
  let now = firstClock;
  const options = { evaluateAutomatically: false, clock: () => new Date(now) };
  await withScenarioServer(file, options, async origin => {
    using database = new DatabaseSync(file);
    const { scenario, manage, receipt } = await completedReview(origin, database);
    const redoPath = scenario.path + "/redo";
    const request = { operationId: "redo-once" };
    await rejection(post(origin, redoPath, request), 409, "REDO_NOT_AVAILABLE");
    await rejection(post(origin, manage, { action: "authorizeRedo" }, "other-teacher"), 403, "FORBIDDEN");
    await result(post(origin, manage, { action: "authorizeRedo" }, "teacher"), z.strictObject({ redoAuthorized: z.literal(true) }));
    await rejection(post(origin, redoPath, request, "other"), 403, "FORBIDDEN");
    now += 9 * 60_000;
    const fresh = await result(post(origin, redoPath, request), startReceipt);
    assert.notEqual(fresh.activityId, scenario.start.activityId);
    assert.notEqual(fresh.stepAttemptId, scenario.start.stepAttemptId);
    assert.equal(fresh.startedAt, new Date(now).toISOString());
    assert.deepEqual(await result(post(origin, redoPath, request), startReceipt), fresh);
    await rejection(post(origin, redoPath, { operationId: "another-redo" }), 409, "REDO_NOT_AVAILABLE");
    await rejection(post(origin, redoPath, { operationId: "start" }), 409, "OPERATION_CONFLICT");
    const linked = await result(get(origin, "/api/activities/" + fresh.activityId), readingState.extend({ redoOf: z.uuid() }));
    assert.equal(linked.redoOf, scenario.start.activityId);
    assert.equal(linked.status, "active");
    assert.equal(linked.assessment, undefined);
    const original = await result(get(origin, scenario.path), readingState);
    assert.deepEqual(original.submission?.receipt, receipt);
    assert.deepEqual(original.assessment, passageScore);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activities WHERE redo_of = ?").get(scenario.start.activityId)?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 2);
  });
});
