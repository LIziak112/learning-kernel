import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { submissionReceipt } from "../src/contracts/reading.ts";
import { evaluatePending } from "../src/kernel/evaluation.ts";
import {
  firstChoices, get, post, prepareAnswers, prepareScenario, readingState, rejection, result,
  scenarioDatabase, withScenarioServer,
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
    evaluatePending(database);
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
      evaluatePending(database);
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
  evaluatePending(database);
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
