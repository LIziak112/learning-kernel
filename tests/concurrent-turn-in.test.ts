import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import { startReceipt, submissionReceipt } from "../src/contracts/reading.ts";
import type { SubmitInput } from "../src/contracts/reading.ts";
import { evaluatePending } from "../src/kernel/evaluation.ts";
import { defaultRegistry } from "./fixtures/evaluators.ts";
import {
  answerSubmission, countFacts, deadline, firstChoices, firstClock, get, post, prepareAnswers, prepareScenario, readingState,
  rejection, result, scenarioDatabase, secondChoices, sessions, withScenarioServer,
} from "./fixtures/online-reading.ts";

for (const [title, winningWindow, sameAnswers] of [
  ["甲先确认", "a", false], ["乙先确认", "b", false], ["相同答案但不同操作", "a", true],
] as const) {
  test(`双端同时交卷｜${title}`, async t => {
    const databasePath = scenarioDatabase(t);
    let now = firstClock;
    const barrier = submissionBarrier();
    const options = {
      evaluateAutomatically: false,
      clock: () => new Date(now),
      beforeConfirmation: barrier.wait,
    };
    await withScenarioServer(databasePath, options, async origin => {
      const scenario = await prepareScenario(origin);
      const choices = { a: firstChoices, b: sameAnswers ? firstChoices : secondChoices };
      const a = await prepareAnswers(origin, scenario, choices.a, "turn-a");
      const b = await prepareAnswers(origin, scenario, choices.b, "turn-b", "window-b");
      const submit = scenario.path + "/submissions";
      now = deadline - 1;
      const losingWindow = winningWindow === "a" ? "b" : "a";
      const requests = { a: post(origin, submit, a), b: post(origin, submit, b, "window-b") };
      let receipt;
      try {
        await barrier.arrived;
        barrier.release(winningWindow);
        receipt = await result(requests[winningWindow], submissionReceipt);
        assert.equal(receipt.confirmedAt, new Date(now).toISOString());
        barrier.release(losingWindow);
        await rejection(requests[losingWindow], 409, "ALREADY_SUBMITTED");
      } finally {
        barrier.release("a");
        barrier.release("b");
        await Promise.allSettled(Object.values(requests));
      }
      const expected = choices[winningWindow];
      const loser = losingWindow === "a" ? a : b;
      const winner = winningWindow === "a" ? a : b;
      const losingSession = "window-" + losingWindow;
      const winningSession = "window-" + winningWindow;
      const before = await result(get(origin, scenario.path, losingSession), readingState);
      assert.equal(before.status, "completed");
      assert.deepEqual(before.assessment, { status: "pending" });
      assert.deepEqual(before.submission?.answer.choices, expected);
      assert.deepEqual(before.submission?.receipt, receipt);
      const reviewPath = `/api/reviews/${scenario.start.activityId}`;
      const review = z.object({ submissions: z.array(z.unknown()) });
      const teacher = await result(get(origin, reviewPath, "teacher"), review);
      assert.equal(teacher.submissions.length, 2);
      assert.deepEqual(answerSubmission.parse(teacher.submissions[1]).answer.choices, expected);
      using database = new DatabaseSync(databasePath);
      assert.deepEqual(countFacts(database), { submissions: 2, selections: 1, answers: 3, completions: 1, tasks: 1, verdicts: 0 });
      assert.equal(database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(receipt.id)?.status, "pending");
      assert.equal(database.prepare("SELECT work_id FROM submissions WHERE id = ?").get(receipt.id)?.work_id, winner.draft.id);
      const kept = database.prepare("SELECT selection FROM work_versions WHERE work_id = ? AND version = ?")
        .get(loser.draft.id, loser.draft.version);
      assert.deepEqual(JSON.parse(String(kept?.selection)).choices, choices[losingWindow]);
      now = deadline + 1;
      assert.deepEqual(await result(post(origin, submit, winner, winningSession), submissionReceipt), receipt);
      await rejection(post(origin, submit, { ...winner, draft: loser.draft }, winningSession), 409, "OPERATION_CONFLICT");
      await rejection(post(origin, submit, { ...loser, operationId: "sealed-after-deadline" }, losingSession), 409, "ALREADY_SUBMITTED");
      await rejection(post(origin, submit, winner, "other"), 403, "FORBIDDEN");
      evaluatePending(database, defaultRegistry);
      const score = winningWindow === "a" ? 1 : 2;
      for (const session of ["window-a", "window-b"]) {
        const state = await result(get(origin, scenario.path, session), readingState);
        assert.deepEqual(state.assessment, { status: "complete", correctCount: score, questionCount: 3 });
        assert.deepEqual(state.submission?.answer.choices, expected);
      }
      assert.deepEqual(countFacts(database), { submissions: 2, selections: 1, answers: 3, completions: 1, tasks: 1, verdicts: 3 });
    });
  });
}

test("双端同时交卷｜恰到截止和截止后均不写入正式作答", async t => {
  const databasePath = scenarioDatabase(t);
  let now = firstClock;
  const barrier = submissionBarrier();
  const options = { evaluateAutomatically: false, clock: () => new Date(now), beforeConfirmation: barrier.wait };
  await withScenarioServer(databasePath, options, async origin => {
    const scenario = await prepareScenario(origin);
    const first = await prepareAnswers(origin, scenario, firstChoices, "turn-a");
    const second = await prepareAnswers(origin, scenario, secondChoices, "turn-b", "window-b");
    now = deadline - 1;
    const requests = [
      post(origin, scenario.path + "/submissions", first),
      post(origin, scenario.path + "/submissions", second, "window-b"),
    ] as const;
    try {
      await barrier.arrived;
      now = deadline;
      barrier.release("a");
      await rejection(requests[0], 409, "DEADLINE_PASSED");
      now++;
      barrier.release("b");
      await rejection(requests[1], 409, "DEADLINE_PASSED");
    } finally {
      barrier.release("a");
      barrier.release("b");
      await Promise.allSettled(requests);
    }
    const state = await result(get(origin, scenario.path), readingState);
    const repeated = await result(post(origin, "/api/activities", { operationId: "start", practiceId: "reading-library" }), startReceipt);
    assert.equal(repeated.startedAt, new Date(firstClock).toISOString());
    assert.equal(repeated.activityId, scenario.start.activityId);
    assert.equal(state.status, "active");
    assert.equal(state.assessment, undefined);
    assert.equal(state.submission, undefined);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(countFacts(database), { submissions: 1, selections: 1, answers: 0, completions: 0, tasks: 0, verdicts: 0 });
    for (const contract of [first, second]) {
      assert.equal(database.prepare("SELECT version FROM work_versions WHERE work_id = ?").get(contract.draft.id)?.version, 1);
    }
  });
});

test("双端同时交卷｜在途会话换绑后按当前主体裁决，原账号仍可交卷", async t => {
  const databasePath = scenarioDatabase(t);
  const currentSessions = new Map(sessions);
  const arrived = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const options = {
    sessions: currentSessions,
    async beforeConfirmation(input: SubmitInput) {
      if (input.operationId !== "switched-session") return;
      arrived.resolve();
      await resume.promise;
    },
  };
  await withScenarioServer(databasePath, options, async origin => {
    const scenario = await prepareScenario(origin);
    const request = await prepareAnswers(origin, scenario, secondChoices, "switched-session", "window-b");
    const submit = scenario.path + "/submissions";
    const response = post(origin, submit, request, "window-b");
    try {
      await Promise.race([arrived.promise, response.then(() => { throw new Error("请求未在裁决前暂停"); })]);
      currentSessions.set("window-b", "student-2");
    } finally {
      resume.resolve();
    }
    await rejection(response, 403, "FORBIDDEN");
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(countFacts(database), { submissions: 1, selections: 1, answers: 0, completions: 0, tasks: 0, verdicts: 0 });
    const receipt = await result(post(origin, submit, request), submissionReceipt);
    assert.equal(database.prepare("SELECT work_id FROM submissions WHERE id = ?").get(receipt.id)?.work_id, request.draft.id);
  });
});

function submissionBarrier() {
  const callbacks = { a: Promise.withResolvers<void>(), b: Promise.withResolvers<void>() };
  const arrivals = { a: Promise.withResolvers<void>(), b: Promise.withResolvers<void>() };
  return {
    arrived: Promise.race([
      Promise.all([arrivals.a.promise, arrivals.b.promise]),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("两份交卷未同时到达服务端屏障")), 3000);
        timer.unref();
      }),
    ]),
    async wait(input: SubmitInput) {
      const window = input.operationId === "turn-a" ? "a" : input.operationId === "turn-b" ? "b" : undefined;
      if (!window) return;
      arrivals[window].resolve();
      await callbacks[window].promise;
    },
    release(window: keyof typeof callbacks) {
      callbacks[window].resolve();
    },
  };
}
