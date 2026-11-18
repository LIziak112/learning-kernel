import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { submissionReceipt } from "../src/contracts/reading.ts";
import {
  answerSubmission, countFacts, deadline, firstChoices, firstClock, get, post, prepareAnswers, prepareScenario, readingState,
  rejection,
  result, scenarioDatabase,
} from "./fixtures/online-reading.ts";
import { launchReadingProcess } from "./fixtures/service-process.ts";
import type { StopPoint } from "./fixtures/service-process.ts";

const verdict = z.strictObject({ submissionId: z.uuid(), targetId: z.string(), questionId: z.string(), correct: z.boolean() });
const grading = z.object({ automaticVerdicts: z.array(verdict) });

test("交卷后重启｜获准教师能核对恢复后的三条自动判定", async t => {
  const databasePath = scenarioDatabase(t);
  const initial = await launchReadingProcess(databasePath, { now: firstClock, evaluateAutomatically: false });
  let scenario;
  let receipt;
  try {
    scenario = await prepareScenario(initial.origin);
    const input = await prepareAnswers(initial.origin, scenario, firstChoices, "turn-a");
    receipt = await result(post(initial.origin, scenario.path + "/submissions", input), submissionReceipt);
    const pending = await result(get(initial.origin, scenario.path), readingState);
    assert.deepEqual(pending.assessment, { status: "pending" });
    assert.deepEqual(pending.submission?.receipt, receipt);
  } finally {
    await initial.stop();
  }
  const reopened = await launchReadingProcess(databasePath, { now: deadline + 1, evaluateAutomatically: true });
  try {
    const complete = await waitForScore(reopened.origin, scenario.path);
    assert.deepEqual(complete.assessment, { status: "complete", correctCount: 1, questionCount: 3 });
    assert.deepEqual(complete.submission?.receipt, receipt);
    const review = await result(get(reopened.origin, `/api/reviews/${scenario.start.activityId}`, "teacher"), grading);
    assert.deepEqual(review.automaticVerdicts, [
      { submissionId: receipt.id, targetId: "interpret", questionId: "q1", correct: true },
      { submissionId: receipt.id, targetId: "interpret", questionId: "q2", correct: false },
      { submissionId: receipt.id, targetId: "interpret", questionId: "q3", correct: false },
    ]);
    await rejection(get(reopened.origin, `/api/reviews/${scenario.start.activityId}`, "other-teacher"), 403, "FORBIDDEN");
    const student = await get(reopened.origin, scenario.path);
    assert.equal(student.status, 200);
    assert.doesNotMatch(await student.text(), /"automaticVerdicts"|"gradingBasis"|"keyRef"|"correct"/);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(countFacts(database), confirmedFacts(3));
  } finally {
    await reopened.stop();
  }
  {
    using database = new DatabaseSync(databasePath);
    database.prepare("UPDATE evaluation_tasks SET status = 'pending' WHERE submission_id = ?").run(receipt.id);
  }
  const repeated = await launchReadingProcess(databasePath, { now: deadline + 2, evaluateAutomatically: true });
  try {
    const complete = await waitForScore(repeated.origin, scenario.path);
    assert.deepEqual(complete.assessment, { status: "complete", correctCount: 1, questionCount: 3 });
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(countFacts(database), confirmedFacts(3));
    assert.equal(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(receipt.id)?.status, "done");
  } finally {
    await repeated.stop();
  }
});

for (const afterDeadline of [false, true]) {
  test(`交卷后重启｜事务提交前中止，${afterDeadline ? "到期保稿" : "截止前重试成功"}`, async t => {
    const databasePath = scenarioDatabase(t);
    const { scenario, input } = await crashDuringTurnIn(databasePath, "beforeConfirmationCommit", false);
    const now = afterDeadline ? deadline : deadline - 1;
    const reopened = await launchReadingProcess(databasePath, { now, evaluateAutomatically: false });
    try {
      const view = await result(get(reopened.origin, scenario.path), readingState);
      assert.equal(view.status, "active");
      assert.equal(view.assessment, undefined);
      assert.equal(view.submission, undefined);
      assert.equal(view.startedAt, new Date(firstClock).toISOString());
      using database = new DatabaseSync(databasePath, { readOnly: true });
      const prior = { submissions: 1, selections: 1, answers: 0, completions: 0, tasks: 0, verdicts: 0 };
      assert.deepEqual(countFacts(database), prior);
      assert.equal(database.prepare("SELECT id FROM submissions WHERE operation_id = 'turn-a'").get(), undefined);
      assert.equal(database.prepare("SELECT version FROM work_versions WHERE work_id = ?").get(input.draft.id)?.version, 1);
      const response = post(reopened.origin, scenario.path + "/submissions", input);
      if (afterDeadline) {
        await rejection(response, 409, "DEADLINE_PASSED");
        assert.deepEqual(countFacts(database), prior);
      } else {
        const receipt = await result(response, submissionReceipt);
        assert.equal(receipt.confirmedAt, new Date(now).toISOString());
        assert.deepEqual(countFacts(database), confirmedFacts(0));
      }
    } finally {
      await reopened.stop();
    }
  });
}

for (const [label, point, acknowledged, initialVerdicts] of [
  ["提交后回执送达前", "afterConfirmationCommit", false, 0],
  ["任务投递前", "beforeEvaluation", true, 0],
  ["首题落盘后", "afterAutomaticVerdict", true, 1],
  ["三题落盘但任务尚未完成", "beforeEvaluationComplete", true, 3],
] as const) {
  test(`交卷后重启｜${label}中止，跨截止重放并补齐评估`, async t => {
    const databasePath = scenarioDatabase(t);
    const { scenario, input, acknowledgedReceipt } = await crashDuringTurnIn(databasePath, point, acknowledged);
    const review = `/api/reviews/${scenario.start.activityId}`;
    const inspect = await launchReadingProcess(databasePath, { now: deadline + 1, evaluateAutomatically: false });
    let original;
    try {
      const pending = await result(get(inspect.origin, scenario.path), readingState);
      assert.equal(pending.startedAt, new Date(firstClock).toISOString());
      assert.equal(pending.status, "completed");
      assert.deepEqual(pending.assessment, { status: "pending" });
      assert.deepEqual(pending.submission?.answer.choices, firstChoices);
      original = pending.submission?.receipt;
      assert.ok(original);
      if (acknowledgedReceipt) assert.deepEqual(original, acknowledgedReceipt);
      using database = new DatabaseSync(databasePath, { readOnly: true });
      assert.deepEqual(countFacts(database), confirmedFacts(initialVerdicts));
      assert.equal(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(original.id)?.status, "pending");
      const read = await result(get(inspect.origin, review, "teacher"), z.object({
        submissions: z.array(z.unknown()), automaticVerdicts: z.array(verdict).optional(),
      }));
      assert.equal(read.submissions.length, 2);
      assert.deepEqual(answerSubmission.parse(read.submissions[1]), pending.submission);
      assert.equal(read.automaticVerdicts?.length ?? 0, initialVerdicts);
      const replay = await result(post(inspect.origin, scenario.path + "/submissions", input), submissionReceipt);
      assert.deepEqual(replay, original);
      assert.deepEqual(countFacts(database), confirmedFacts(initialVerdicts));
    } finally {
      await inspect.stop();
    }
    const recover = await launchReadingProcess(databasePath, { now: deadline + 2, evaluateAutomatically: true });
    try {
      const complete = await waitForScore(recover.origin, scenario.path);
      assert.deepEqual(complete.assessment, { status: "complete", correctCount: 1, questionCount: 3 });
      assert.deepEqual(complete.submission?.receipt, original);
      const returned = await result(get(recover.origin, review, "teacher"), grading);
      assert.deepEqual(returned.automaticVerdicts.map(row => [row.questionId, row.correct]), [["q1", true], ["q2", false], ["q3", false]]);
      using database = new DatabaseSync(databasePath, { readOnly: true });
      assert.deepEqual(countFacts(database), confirmedFacts(3));
      assert.equal(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(original.id)?.status, "done");
    } finally {
      await recover.stop();
    }
  });
}

async function crashDuringTurnIn(databasePath: string, point: StopPoint, acknowledged: boolean) {
  const child = await launchReadingProcess(databasePath, { now: firstClock, evaluateAutomatically: acknowledged, stopAt: point });
  try {
    const scenario = await prepareScenario(child.origin);
    const input = await prepareAnswers(child.origin, scenario, firstChoices, "turn-a");
    const response = post(child.origin, scenario.path + "/submissions", input);
    const outcome = Promise.allSettled([response]);
    const checkpoint = await child.waitFor(point);
    const acknowledgedReceipt = acknowledged ? await result(response, submissionReceipt) : undefined;
    if (acknowledgedReceipt) assert.equal(checkpoint.submissionId, acknowledgedReceipt.id);
    await child.stop();
    if (!acknowledged) {
      const [failed] = await outcome;
      assert.equal(failed?.status, "rejected");
      if (failed?.status === "rejected") assert.ok(failed.reason instanceof TypeError);
    }
    return { scenario, input, acknowledgedReceipt };
  } finally {
    await child.stop();
  }
}

function confirmedFacts(verdicts: number) {
  return { submissions: 2, selections: 1, answers: 3, completions: 1, tasks: 1, verdicts };
}

async function waitForScore(origin: string, path: string) {
  for (let check = 0; check < 40; check++) {
    const view = await result(get(origin, path), readingState);
    if (view.assessment?.status === "complete") return view;
    await delay(25);
  }
  throw new Error("重启后一秒内没有恢复整篇初判");
}
