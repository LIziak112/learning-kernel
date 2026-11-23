import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { startReceipt, submissionReceipt } from "../src/contracts/reading.ts";
import { openLearningRuntime } from "../src/server.ts";
import type { VerdictCommand } from "../src/server.ts";
import { frozenChoicePublication, questionVersions } from "./fixtures/frozen-choice.ts";
import { evaluatePending } from "../src/kernel/pending-evaluation.ts";
import { choiceEvaluator } from "./fixtures/evaluators.ts";
import { defaultRegistry } from "./fixtures/evaluators.ts";
import { reviewAccess } from "./fixtures/evaluators.ts";
import {
  countFacts, firstChoices, get, post, prepareAnswers, prepareScenario, readingState, rejection, result,
  scenarioDatabase, withScenarioServer, reviewerSessions,
} from "./fixtures/online-reading.ts";

const location = z.strictObject({ submissionId: z.uuid(), targetId: z.string(), questionId: z.string() });
const reviewReceipt = location.extend({ id: z.uuid(), revision: z.int().positive() });
const current = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("automatic"), correct: z.boolean() }),
  z.strictObject({ source: z.literal("teacherReview"), id: z.uuid(), correct: z.boolean() }),
]);
const recorded = reviewReceipt.extend({
  action: z.enum(["override", "withdraw"]),
  reviewerId: z.string(),
  reason: z.string(),
  reviewedAt: z.iso.datetime(),
  correct: z.boolean().optional(),
  withdrawId: z.uuid().optional(),
});
const verdicts = z.object({
  verdicts: z.array(location.extend({
    revision: z.int().nonnegative(),
    choice: z.string().optional(),
    prompt: z.string().optional(),
    effective: current.optional(),
    automatic: z.strictObject({ correct: z.boolean(), valid: z.boolean() }).optional(),
    history: z.array(recorded).optional(),
  })),
});

test("同题连续改判｜修订 0 到 4 保留全部历史并按次序回落", async t => {
  const file = scenarioDatabase(t);
  const accounts = new Map([...reviewerSessions, ["teacher-second-window", "teacher-1"]]);
  await withScenarioServer(file, { reviewerSessions: accounts }, async origin => {
    const { scenario, receipt, review } = await submittedScenario(origin);
    const scope = { submissionId: receipt.id, targetId: "interpret", questionId: "q2" };
    const path = review + "/verdicts";
    using database = new DatabaseSync(file);
    evaluatePending(database, defaultRegistry);
    const facts = countFacts(database);
    const first = {
      ...scope, action: "override", operationId: "review-1", expectedRevision: 0,
      reason: "题目条件足以支持该选项", correct: true,
    };
    await score(origin, scenario.path, 1);
    const projected = verdicts.safeParse(await result(get(origin, review, "teacher"), z.unknown()));
    assert.ok(projected.success, projected.error?.message);
    const initial = projected.data.verdicts.find(row => row.questionId === "q2");
    assert.equal(initial?.revision, 0);
    assert.deepEqual(initial?.effective, { source: "automatic", correct: false });
    await rejection(post(origin, path, { ...first, questionId: "q-missing" }, "teacher"), 403, "FORBIDDEN");
    await rejection(post(origin, path, { ...first, targetId: "cite" }, "teacher"), 403, "FORBIDDEN");
    await rejection(post(origin, path, { ...first, submissionId: scenario.quote.id }, "teacher"), 403, "FORBIDDEN");
    const firstReceipt = await result(post(origin, path, first, "teacher"), reviewReceipt);
    assert.deepEqual(firstReceipt, { ...scope, id: firstReceipt.id, revision: 1 });
    await score(origin, scenario.path, 2);
    await rejection(post(origin, path, { ...first, operationId: "stale-other" }, "teacher-second-window"), 409, "VERDICT_CONFLICT");

    const secondReceipt = await result(post(origin, path, {
      ...first, operationId: "review-2", expectedRevision: 1, reason: "复核时误将条件看作无关", correct: false,
    }, "teacher-second-window"), reviewReceipt);
    assert.equal(secondReceipt.revision, 2);
    await score(origin, scenario.path, 1);

    const withdraw = {
      ...scope, action: "withdraw", operationId: "withdraw-2", expectedRevision: 2,
      reason: "撤销这次误改", withdrawId: secondReceipt.id,
    };
    await rejection(post(origin, path, { ...withdraw, withdrawId: firstReceipt.id }, "teacher"), 409, "VERDICT_CONFLICT");
    const third = await result(post(origin, path, withdraw, "teacher"), reviewReceipt);
    assert.equal(third.revision, 3);
    const afterThird = await result(get(origin, review, "teacher"), verdicts);
    assert.deepEqual(afterThird.verdicts.find(row => row.questionId === "q2")?.effective,
      { source: "teacherReview", id: firstReceipt.id, correct: true });
    await score(origin, scenario.path, 2);

    const fourth = await result(post(origin, path, {
      ...withdraw, operationId: "withdraw-1", expectedRevision: 3, reason: "退回初判供复核", withdrawId: firstReceipt.id,
    }, "teacher"), reviewReceipt);
    assert.equal(fourth.revision, 4);
    await score(origin, scenario.path, 1);
    assert.deepEqual(await result(post(origin, path, first, "teacher"), reviewReceipt), firstReceipt);
    assert.deepEqual(await result(post(origin, path, withdraw, "teacher"), reviewReceipt), third);
    await rejection(post(origin, path, { ...withdraw, withdrawId: firstReceipt.id }, "teacher"), 409, "OPERATION_CONFLICT");
    await rejection(post(origin, path, {
      ...withdraw, operationId: "withdraw-after-automatic", expectedRevision: 4, withdrawId: firstReceipt.id,
    }, "teacher"), 409, "VERDICT_CONFLICT");
    await rejection(post(origin, path, { ...first, operationId: "stale-at-four" }, "teacher"), 409, "VERDICT_CONFLICT");
    await rejection(post(origin, path, { ...first, correct: false }, "teacher"), 409, "OPERATION_CONFLICT");
    await rejection(post(origin, path, first, "other-teacher"), 403, "FORBIDDEN");
    await rejection(post(origin, path, first), 403, "FORBIDDEN");
    const history = (await result(get(origin, review, "teacher"), verdicts)).verdicts;
    assert.deepEqual(history.map(item => [item.questionId, item.revision, item.choice, item.effective?.correct]), [
      ["q1", 0, "A", true], ["q2", 4, "B", false], ["q3", 0, "A", false],
    ]);
    const changed = history[1];
    assert.match(changed?.prompt ?? "", /同期/);
    assert.deepEqual(changed?.automatic, { correct: false, valid: true });
    assert.deepEqual(changed?.effective, { source: "automatic", correct: false });
    assert.deepEqual(changed?.history?.map(event => [event.id, event.revision, event.action, event.correct, event.withdrawId]), [
      [firstReceipt.id, 1, "override", true, undefined],
      [secondReceipt.id, 2, "override", false, undefined],
      [third.id, 3, "withdraw", undefined, secondReceipt.id],
      [fourth.id, 4, "withdraw", undefined, firstReceipt.id],
    ]);
    assert.deepEqual(countFacts(database), facts);
    assert.deepEqual(database.prepare("SELECT revision FROM verdict_events ORDER BY revision").all().map(row => row.revision), [1, 2, 3, 4]);
    const student = await get(origin, scenario.path);
    assert.equal(student.status, 200);
    assert.doesNotMatch(await student.text(), /"effective"|"history"|"automatic"|"correct"|题目条件足以支持/);
  });
});

for (const allowed of ["gradingBasis", "verdictHistory"] as const) {
  test(`同题连续改判｜教师声明仅允许 ${allowed} 时按范围投影`, async t => {
    const file = scenarioDatabase(t);
    const publication = structuredClone(reading);
    publication.practice.policy.reviewer.fields = [allowed];
    if (allowed === "gradingBasis") publication.practice.policy.reviewer.actions = [];
    await withScenarioServer(file, { publication }, async origin => {
      const { receipt, review } = await submittedScenario(origin);
      using database = new DatabaseSync(file);
      evaluatePending(database, defaultRegistry);
      const command = {
        submissionId: receipt.id, targetId: "interpret", questionId: "q2",
        action: "override", operationId: "one", expectedRevision: 0, reason: "仅历史可读的依据", correct: true,
      };
      if (allowed === "verdictHistory") {
        await result(post(origin, review + "/verdicts", command, "teacher"), reviewReceipt);
      } else {
        await rejection(post(origin, review + "/verdicts", command, "teacher"), 403, "FORBIDDEN");
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM verdict_events").get()?.count, 0);
      }
      const detail = await result(get(origin, review, "teacher"), verdicts);
      const second = detail.verdicts.find(row => row.questionId === "q2");
      assert.ok(second);
      assert.equal(second.choice, undefined);
      assert.equal(second.prompt, undefined);
      if (allowed === "verdictHistory") {
        assert.equal(second.automatic, undefined);
        assert.equal(second.effective, undefined);
        assert.equal(second.history?.[0]?.reason, command.reason);
      } else {
        assert.deepEqual(second.automatic, { valid: true, correct: false });
        assert.equal(second.history, undefined);
      }
    });
  });
}

test("同题连续改判｜迟到初判保留来源，候选失效后回到整篇待评", async t => {
  const file = scenarioDatabase(t);
  await withScenarioServer(file, {}, async origin => {
    const { scenario, receipt, review } = await submittedScenario(origin);
    const scope = { submissionId: receipt.id, targetId: "interpret", questionId: "q2" };
    const path = review + "/verdicts";
    const revision = await result(post(origin, path, {
      ...scope, action: "override", operationId: "early", expectedRevision: 0, reason: "先核对文本条件", correct: true,
    }, "teacher"), reviewReceipt);
    assert.equal(revision.revision, 1);
    assert.deepEqual((await result(get(origin, scenario.path), readingState)).assessment, { status: "pending" });
    using database = new DatabaseSync(file);
    evaluatePending(database, defaultRegistry);
    await score(origin, scenario.path, 2);
    const amended = (await result(get(origin, review, "teacher"), verdicts)).verdicts.find(row => row.questionId === "q2");
    assert.deepEqual(amended?.automatic, { correct: false, valid: true });
    assert.deepEqual(amended?.effective, { source: "teacherReview", id: revision.id, correct: true });
    database.prepare("UPDATE automatic_verdicts SET valid = 0 WHERE submission_id = ? AND question_id = ?").run(receipt.id, "q2");
    await score(origin, scenario.path, 2);
    const reverted = await result(post(origin, path, {
      ...scope, action: "withdraw", operationId: "withdraw", expectedRevision: 1, reason: "退回待评", withdrawId: revision.id,
    }, "teacher"), reviewReceipt);
    assert.equal(reverted.revision, 2);
    const unavailable = await result(get(origin, scenario.path), readingState);
    assert.deepEqual(unavailable.assessment, { status: "pending" });
    const caseHistory = (await result(get(origin, review, "teacher"), verdicts)).verdicts;
    assert.equal(caseHistory[1]?.effective, undefined);
    assert.deepEqual(caseHistory[1]?.automatic, { correct: false, valid: false });
    assert.equal(caseHistory[1]?.history?.length, 2);
    assert.deepEqual(countFacts(database), { submissions: 2, selections: 1, answers: 3, completions: 1, tasks: 1, verdicts: 3 });
  });
});

test("同题连续改判｜写入失败不占用修订或操作标识，原命令可以重试", async t => {
  t.mock.method(console, "error", () => undefined);
  const file = scenarioDatabase(t);
  await withScenarioServer(file, {}, async origin => {
    const { scenario, receipt, review } = await submittedScenario(origin);
    const command = {
      submissionId: receipt.id, targetId: "interpret", questionId: "q2",
      action: "override", operationId: "review-1", expectedRevision: 0, reason: "核对原答", correct: true,
    };
    const path = review + "/verdicts";
    using database = new DatabaseSync(file);
    evaluatePending(database, defaultRegistry);
    database.exec(`
      CREATE TRIGGER invalid_review BEFORE INSERT ON verdict_events
      BEGIN SELECT RAISE(ABORT, 'test review failure'); END;
    `);
    await rejection(post(origin, path, command, "teacher"), 500, "INTERNAL_ERROR");
    await score(origin, scenario.path, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM verdict_events").get()?.count, 0);
    database.exec("DROP TRIGGER invalid_review");
    const reviewed = await result(post(origin, path, command, "teacher"), reviewReceipt);
    assert.equal(reviewed.revision, 1);
    await score(origin, scenario.path, 2);
  });
});

async function submittedScenario(origin: string) {
  const scenario = await prepareScenario(origin);
  const command = await prepareAnswers(origin, scenario, firstChoices, "turn-a");
  const receipt = await result(post(origin, scenario.path + "/submissions", command), submissionReceipt);
  return { scenario, receipt, review: `/api/reviews/${scenario.start.activityId}` };
}

async function score(origin: string, path: string, expected: number) {
  const state = await result(get(origin, path), readingState);
  assert.deepEqual(state.assessment, { status: "complete", correctCount: expected, questionCount: 3 });
}

test("原单选连续改判后逐次撤销回落到上一条有效教师改判，内置与公开读面一致", async t => {
  const file = scenarioDatabase(t);
  const student = { role: "student", id: "student-1" } as const;
  const reviewer = { role: "reviewer", id: "teacher-1" } as const;
  const evaluator = { id: "choice-review-check", version: 1 };
  const { practice, scoringKey } = frozenChoicePublication;
  const [step] = practice.steps;
  const questions = practice.questions.map(question => ({ ...question, version: questionVersions.get(question.id) ?? 1 }));
  const [first, second] = questions;
  assert.ok(first && second);
  const runtime = openLearningRuntime({
    databasePath: file,
    evaluators: [choiceEvaluator(evaluator, ({ choice, acceptedChoice }) => choice === acceptedChoice)],
    authorizeConfirmationRecovery: ({ studentId }) => studentId === student.id,
    authorizeReview: reviewAccess({ choiceConfirmation: {
      read: scope => scope.reviewerId === reviewer.id && scope.studentId === student.id,
      write: scope => scope.reviewerId === reviewer.id && scope.studentId === student.id,
    } }),
  });
  try {
    runtime.publish({
      practice: {
        ...practice, questions,
        steps: [{ ...step, submit: { ...step.submit, slots: { answers: {
          ...step.submit.slots.answers, confirmFromDrafts: { allowUnanswered: false },
        } } } }],
        grading: { assessment: { ...practice.grading.assessment, evaluator } },
        policy: {
          ...practice.policy,
          student: { ...practice.policy.student, passageScore: { whenAll: ["finalConfirmed", "allQuestionsJudged"],
            group: "wholePassage", fields: ["correctCount", "questionCount"], allowSubsets: false, drilldown: false },
          },
          reviewer: { ...practice.policy.reviewer, fields: ["gradingBasis", "verdictHistory"], actions: ["reviseQuestionVerdict"] },
        },
      },
      scoringKey,
    });
    await withScenarioServer(file, {}, async origin => {
      const { activityId, stepAttemptId } = await result(post(origin, "/api/activities", {
        practiceId: practice.id, operationId: "open-choice",
      }), startReceipt);
      const slotId = "answers";
      const key = { protocolVersion: 1, stepAttemptId, operationId: "confirm-choice" } as const;
      const revisions = [first, second].map(({ id: questionId, version: questionVersion }, index) => {
        const draft = runtime.saveChoiceDraft(student, activityId, { ...key, operationId: "save", baseRevision: 0,
          slotId, questionId, questionVersion, choice: index === 0 ? "1" : "0",
        });
        return { questionId, questionVersion, revision: draft.revision, original: { state: "uncollected" } as const };
      });
      const receipt = runtime.confirmChoices(student, activityId, { ...key, slotId, questions: revisions });
      runtime.evaluatePending();
      const original = runtime.recoverChoiceConfirmation(student, activityId, key);
      assert.equal(original.evaluation?.correctCount, 1);
      const studentPath = "/api/activities/" + activityId + "/assessment";
      const teacherPath = "/api/reviews/" + activityId;
      const teacherWrite = (command: VerdictCommand) => post(origin, teacherPath + "/verdicts", command, "teacher");
      const readScore = async (correctCount: number) => {
        const response = await result(get(origin, studentPath), readingState.pick({ assessment: true }));
        assert.deepEqual(response.assessment, { status: "complete", questionCount: 2, correctCount });
      };
      await readScore(1);
      const position = { protocolVersion: 1, submissionId: receipt.id, targetId: step.id, questionId: second.id } as const;
      const early = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, {
        ...position, operationId: "first-override", action: "override", expectedRevision: 0, correct: true, reason: "复核原答",
      }, "choiceConfirmation");
      await readScore(2);
      const late = await result(teacherWrite({
        ...position, operationId: "second-override", action: "override", expectedRevision: 1, correct: false, reason: "再次核对",
      }), reviewReceipt);
      await readScore(1);
      const clear = { ...position, operationId: "clear-override", action: "withdraw", expectedRevision: 2,
        withdrawId: late.id, reason: "清除覆盖判定" } as const;
      const cleared = await result(teacherWrite(clear), reviewReceipt);
      assert.equal(cleared.revision, 3);
      assert.deepEqual(await result(teacherWrite(clear), reviewReceipt), cleared);
      await readScore(2);
      const effectiveOf = async () => {
        const teacherView = await result(get(origin, teacherPath, "teacher"), verdicts);
        const publicView = runtime.readQuestionDeliveryReview(reviewer, activityId, key, "choiceConfirmation");
        const verdict = publicView.questions.find(item => item.questionId === second.id);
        assert.ok(verdict?.status === "judged");
        assert.deepEqual(teacherView.verdicts.find(item => item.questionId === second.id)?.effective, verdict.effective);
        return verdict.effective;
      };
      assert.deepEqual(await effectiveOf(), { source: "teacherReview", id: early.id, correct: true });
      await rejection(teacherWrite({ ...clear, operationId: "clear-stale", expectedRevision: 3, withdrawId: late.id }),
        409, "VERDICT_CONFLICT");
      const reverted = await result(teacherWrite({ ...clear, operationId: "clear-early", expectedRevision: 3, withdrawId: early.id }),
        reviewReceipt);
      assert.equal(reverted.revision, 4);
      await readScore(1);
      assert.deepEqual(await effectiveOf(), { source: "automatic", correct: false });
      assert.deepEqual(runtime.recoverChoiceConfirmation(student, activityId, key), original);
    });
  } finally {
    runtime.close();
  }
});
