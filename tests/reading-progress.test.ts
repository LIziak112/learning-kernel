import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ZodType } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { materialSchema, startReceipt, submissionReceipt, versionRef } from "../src/contracts/reading.ts";
import { readingAnswer, readingAnswerDraft, readingDraftReceipt, readingSelection } from "../src/contracts/reading-runtime.ts";
import { createLearningServer } from "../src/host/server.ts";
import { evaluatePending } from "../src/kernel/pending-evaluation.ts";
import { defaultRegistry } from "./fixtures/evaluators.ts";

const activityView = startReceipt.extend({
  formatVersion: z.literal(1),
  title: z.string(),
  material: materialSchema,
  step: z.strictObject({ id: z.string(), instructions: z.string(), tool: versionRef, submit: z.unknown() }),
  status: z.literal("active"),
  inputs: z.record(z.string(), z.unknown()),
  submission: z.unknown().optional(),
});

const ranges = [
  { role: "observation", paragraphId: "p2", start: 0, end: 22 },
  { role: "condition", paragraphId: "p3", start: 0, end: 18 },
];

test("确认两段选据后放行答题，第二步读取的引文保留原材料位置", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const first = await readResult(get(origin, path), activityView);
    assert.equal(first.step.id, "evidence");
    assert.equal(first.stepAttemptId, started.stepAttemptId);
    assert.deepEqual(Object.keys(first.inputs), ["passage"]);
    assert.deepEqual(first.inputs.passage, { from: "material", positionId: "evidence-passage" });
    const saved = await readResult(post(origin, path + "/drafts", {
      stepAttemptId: first.stepAttemptId, slotId: "quotes", ranges,
    }), readingDraftReceipt);
    assert.deepEqual(saved.selection.material, reading.practice.material);
    assert.equal(saved.selection.positionId, "evidence-passage");
    assert.deepEqual(saved.selection.ranges.map(item => [item.role, item.range.paragraphId, item.text]), [
      ["observation", "p2", reading.material.paragraphs[1]?.text],
      ["condition", "p3", reading.material.paragraphs[2]?.text],
    ]);
    const input = {
      stepAttemptId: first.stepAttemptId, slotId: "quotes", draft: saved.draft, operationId: "confirm",
    };
    const receipt = await readResult(post(origin, path + "/submissions", input), submissionReceipt);
    const second = await readResult(get(origin, path), activityView);
    assert.equal(second.step.id, "decide");
    assert.notEqual(second.stepAttemptId, first.stepAttemptId);
    assert.deepEqual(second.inputs.passage, { from: "material", positionId: "decide-passage" });
    assert.deepEqual(second.inputs.quotes, { from: "submission", receipt, selection: saved.selection });
    assert.deepEqual(second.inputs.items, { from: "questions", questions: reading.practice.questions });
    assert.deepEqual(await readResult(post(origin, path + "/submissions", input), submissionReceipt), receipt);
    assert.deepEqual(await startReading(origin), started);
    await assertError(post(origin, path + "/submissions", { ...input, operationId: "other-operation" }), 409, "ALREADY_SUBMITTED");
    const detail = z.strictObject({ receipt: submissionReceipt, selection: readingSelection });
    assert.deepEqual(await readResult(get(origin, path + "/submissions/" + receipt.id), detail), { receipt, selection: saved.selection });
    await assertError(get(origin, path, "other"), 403, "FORBIDDEN");
    await assertError(get(origin, path + "/submissions/" + receipt.id, "other"), 403, "FORBIDDEN");
    await assertError(post(origin, path + "/submissions", input, "other"), 403, "FORBIDDEN");
    const other = await startReading(origin, "start", "other");
    await assertError(get(origin, `/api/activities/${other.activityId}/submissions/${receipt.id}`, "other"), 403, "FORBIDDEN");
    using database = new DatabaseSync(databasePath, { readOnly: true });
    const attempts = database.prepare("SELECT step_id FROM step_attempts WHERE activity_id = ? ORDER BY ordinal").all(started.activityId);
    assert.deepEqual(attempts.map(row => row.step_id), ["evidence", "decide"]);
    const performances = database.prepare("SELECT submission_id, target_id FROM performances").all();
    assert.deepEqual(performances.map(row => [row.submission_id, row.target_id]), [[receipt.id, "cite"]]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 1);
  });
});

test("少一段或两用途同段仍保稿，直到完整提交才放行第二步", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const binding = { stepAttemptId: started.stepAttemptId, slotId: "quotes" };
    const observation = ranges[0];
    assert.ok(observation);
    const partial = await readResult(post(origin, path + "/drafts", { ...binding, ranges: [observation] }), readingDraftReceipt);
    assert.equal(partial.selection.ranges.length, 1);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: partial.draft, operationId: "confirm" }),
      422, "INCOMPLETE_SELECTION");
    const same = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: partial.draft.id, ranges: [observation, { ...observation, role: "condition" }],
    }), readingDraftReceipt);
    assert.equal(same.draft.version, 2);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: same.draft, operationId: "confirm" }),
      422, "SELECTION_REQUIRES_DISTINCT_PARAGRAPHS");
    const duplicate = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: same.draft.id, ranges: ranges.map(range => ({ ...range, role: "observation" })),
    }), readingDraftReceipt);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: duplicate.draft, operationId: "confirm" }),
      422, "INCOMPLETE_SELECTION");
    const first = await readResult(get(origin, path), activityView);
    assert.equal(first.stepAttemptId, started.stepAttemptId);
    assert.equal(first.step.id, "evidence");
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(database.prepare("SELECT version FROM work_versions ORDER BY version").all().map(row => row.version), [1, 2, 3]);
    for (const table of ["submissions", "performances", "completions"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    const full = await readResult(post(origin, path + "/drafts", { ...binding, ranges, workId: same.draft.id }), readingDraftReceipt);
    await readResult(post(origin, path + "/submissions", { ...binding, draft: full.draft, operationId: "confirm" }), submissionReceipt);
    assert.equal((await readResult(get(origin, path), activityView)).step.id, "decide");
  });
});

test("不同步骤复用槽位名称时只交付声明指定的原引文", async t => {
  const [first, answer] = reading.practice.steps;
  assert.ok(first && answer?.inputs.quotes);
  const second = {
    ...first, id: "follow-up", requires: first.id,
    inputs: { passage: { from: "material", positionId: "follow-up-passage" } },
  };
  const third = {
    ...answer, requires: second.id,
    inputs: { ...answer.inputs, quotes: { ...answer.inputs.quotes, stepId: second.id } },
  };
  const publication = { ...reading, practice: { ...reading.practice, steps: [first, second, third] } };
  await runReadingServer(temporaryPath(t), publication, async origin => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const firstReceipt = await confirmSelection(origin, path, started.stepAttemptId, "first");
    const middle = await readResult(get(origin, path), activityView);
    assert.equal(middle.step.id, second.id);
    const secondReceipt = await confirmSelection(origin, path, middle.stepAttemptId, "second");
    const last = await readResult(get(origin, path), activityView);
    assert.equal(last.step.id, third.id);
    const quotes = z.object({ from: z.literal("submission"), receipt: submissionReceipt, selection: readingSelection })
      .parse(last.inputs.quotes);
    assert.deepEqual(quotes.receipt, secondReceipt);
    assert.notEqual(quotes.receipt.id, firstReceipt.id);
    assert.equal(quotes.selection.positionId, "follow-up-passage");
  });
});

test("历史声明的工具或材料绑定不可用时，服务拒绝保存选区", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}/drafts`;
    using database = new DatabaseSync(databasePath);
    const update = database.prepare("UPDATE practices SET definition = ? WHERE id = ? AND version = ?");
    const [first, second] = reading.practice.steps;
    assert.ok(first && second);
    const input = { stepAttemptId: started.stepAttemptId, slotId: "quotes", ranges };
    for (const sample of [
      { step: { ...first, tool: { ...first.tool, version: 42 } }, status: 422, code: "INVALID_SLOT" },
      { step: { ...first, inputs: {} }, status: 409, code: "PRACTICE_NOT_RUNNABLE" },
    ]) {
      const value = { ...reading.practice, steps: [sample.step, second] };
      update.run(JSON.stringify(value), value.id, value.version);
      await assertError(post(origin, path, input), sample.status, sample.code);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM works").get()?.count, 0);
  });
});

async function confirmSelection(origin: string, path: string, stepAttemptId: string, operationId: string) {
  const binding = { stepAttemptId, slotId: "quotes" };
  const saved = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
  return readResult(post(origin, path + "/submissions", { ...binding, draft: saved.draft, operationId }), submissionReceipt);
}

test("已交引文跨重启与升版仍固定在原活动的作品和材料版本", async t => {
  const filename = temporaryPath(t);
  const previous = await runReadingServer(filename, reading, async origin => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const binding = { stepAttemptId: started.stepAttemptId, slotId: "quotes" };
    const saved = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
    const receipt = await readResult(post(origin, path + "/submissions", {
      ...binding, draft: saved.draft, operationId: "confirm",
    }), submissionReceipt);
    const revised = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: saved.draft.id, ranges: ranges.map(range => ({ ...range, end: range.end - 1 })),
    }), readingDraftReceipt);
    assert.equal(revised.draft.version, 2);
    assert.notDeepEqual(revised.selection, saved.selection);
    await assertError(post(origin, path + "/submissions", {
      ...binding, draft: revised.draft, operationId: "confirm",
    }), 409, "OPERATION_CONFLICT");
    return { started, path, receipt, selection: saved.selection };
  });
  const material = { ...reading.material, version: 2, title: "第二版图书馆原文" };
  const practice = { ...reading.practice, version: 2, material: { id: material.id, version: material.version } };
  await runReadingServer(filename, { ...reading, material, practice }, async origin => {
    const newStart = await startReading(origin, "start-new");
    const fresh = await readResult(get(origin, `/api/activities/${newStart.activityId}`), activityView);
    assert.equal(fresh.material.version, 2);
    assert.equal(fresh.material.title, material.title);
    const restored = await readResult(get(origin, previous.path), activityView);
    assert.equal(restored.material.version, 1);
    assert.equal(restored.step.id, "decide");
    assert.deepEqual(restored.inputs.quotes, { from: "submission", receipt: previous.receipt, selection: previous.selection });
    assert.deepEqual(await startReading(origin), previous.started);
  });
});

test("第二步只接收声明绑定的工具输入，且另一活动的草稿不能交到本步", async t => {
  await withReadingServer(t, async origin => {
    const a = await startReading(origin);
    const b = await startReading(origin, "another");
    const path = `/api/activities/${a.activityId}`;
    const binding = { stepAttemptId: a.stepAttemptId, slotId: "quotes" };
    await assertError(post(origin, path + "/drafts", { range: { paragraphId: "p2", start: 0, end: 1 } }),
      422, "INVALID_DRAFT");
    await assertError(post(origin, path + "/drafts", { ...binding, slotId: "missing", ranges }), 422, "INVALID_SLOT");
    await assertError(post(origin, path + "/drafts", { ...binding, stepAttemptId: b.stepAttemptId, ranges }), 403, "FORBIDDEN");
    await assertError(post(origin, path + "/drafts", {
      ...binding, ranges: ranges.map(range => ({ ...range, role: "unallowed" })),
    }), 422, "INVALID_SELECTION");
    const foreign = await readResult(post(origin, `/api/activities/${b.activityId}/drafts`, {
      ...binding, stepAttemptId: b.stepAttemptId, ranges,
    }), readingDraftReceipt);
    await assertError(post(origin, path + "/submissions", { ...binding, draft: foreign.draft, operationId: "confirm" }), 403, "FORBIDDEN");
    const own = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
    await readResult(post(origin, path + "/submissions", { ...binding, draft: own.draft, operationId: "confirm" }), submissionReceipt);
    const second = await readResult(get(origin, path), activityView);
    await assertError(post(origin, path + "/drafts", {
      ...binding, stepAttemptId: second.stepAttemptId, slotId: "choices", ranges,
    }), 422, "INVALID_SLOT");
  });
});

test("写入下一步骤失败时，选据确认及原始表现一起回滚", async t => {
  t.mock.method(console, "error", () => undefined);
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const binding = { stepAttemptId: started.stepAttemptId, slotId: "quotes" };
    const saved = await readResult(post(origin, path + "/drafts", { ...binding, ranges }), readingDraftReceipt);
    using database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER fail_advance BEFORE INSERT ON step_attempts
      WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'test advance failure'); END;
    `);
    const request = { ...binding, draft: saved.draft, operationId: "confirm" };
    await assertError(post(origin, path + "/submissions", request), 500, "INTERNAL_ERROR");
    const current = await readResult(get(origin, path), activityView);
    assert.equal(current.stepAttemptId, started.stepAttemptId);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM performances").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_versions").get()?.count, 1);
    database.exec("DROP TRIGGER fail_advance");
    await readResult(post(origin, path + "/submissions", request), submissionReceipt);
    assert.equal((await readResult(get(origin, path), activityView)).step.id, "decide");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 1);
  });
});

test("交卷事务同时固定原答、活动完成和待评任务", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const path = `/api/activities/${started.activityId}`;
    const source = await confirmSelection(origin, path, started.stepAttemptId, "quotes");
    const second = await readResult(get(origin, path), activityView);
    const binding = { stepAttemptId: second.stepAttemptId, slotId: "choices" };
    const choices = { q1: "A", q2: "B", q3: "A" };
    const saved = await readResult(post(origin, path + "/drafts", {
      ...binding, choices, references: { basis: source.id },
    }), readingAnswerDraft);
    const receipt = await readResult(post(origin, path + "/submissions", {
      ...binding, operationId: "turn-in", draft: saved.draft,
    }), submissionReceipt);
    const state = await readResult(get(origin, path), activityView.extend({
      status: z.literal("completed"), assessment: z.strictObject({ status: z.literal("pending") }),
    }));
    assert.deepEqual(state.assessment, { status: "pending" });
    const detail = z.strictObject({ receipt: submissionReceipt, answer: readingAnswer });
    assert.deepEqual(detail.parse(state.submission), { receipt, answer: saved.answer });
    using database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT submission_id FROM completions WHERE activity_id = ?").get(started.activityId)?.submission_id, receipt.id);
    const job = database.prepare("SELECT status, key_id, key_version FROM evaluation_tasks WHERE submission_id = ?").get(receipt.id);
    assert.deepEqual([job?.status, job?.key_id, job?.key_version], ["pending", "library-key", 1]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM performances").get()?.count, 4);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automatic_verdicts").get()?.count, 0);
    const evaluator = database.prepare(`
      UPDATE practices SET definition = json_set(definition, '$.grading.assessment.evaluator.id', ?) WHERE id = ?
    `);
    evaluator.run("unavailable-evaluator", reading.practice.id);
    assert.deepEqual(evaluatePending(database, defaultRegistry), { evaluated: 0, retrying: 0, failed: 0, deferred: 1 });
    assert.equal(database.prepare("SELECT status FROM evaluation_tasks").get()?.status, "pending");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automatic_verdicts").get()?.count, 0);
    evaluator.run(reading.practice.grading.assessment.evaluator.id, reading.practice.id);
    assert.deepEqual(evaluatePending(database, defaultRegistry), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
    const complete = await readResult(get(origin, path), activityView.extend({
      status: z.literal("completed"),
      assessment: z.strictObject({ status: z.literal("complete"), correctCount: z.int(), questionCount: z.int() }),
    }));
    assert.deepEqual(complete.assessment, { status: "complete", correctCount: 1, questionCount: 3 });
    assert.deepEqual(detail.parse(complete.submission).answer.choices, choices);
    assert.doesNotMatch(JSON.stringify(complete), /"keyRef"|"acceptedChoices"|"correct"|"gradingBasis"/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automatic_verdicts").get()?.count, 3);
    assert.equal(database.prepare("SELECT status FROM evaluation_tasks").get()?.status, "done");
  });
});

test("伪造引文引用被拒绝，非法选项保稿，待评写入失败时整次交卷回滚", async t => {
  t.mock.method(console, "error", () => undefined);
  await withReadingServer(t, async (origin, databasePath) => {
    const ready = await readyToAnswer(origin);
    const { path, binding, references } = ready;
    const other = await readyToAnswer(origin, "other-activity");
    await assertError(post(origin, path + "/drafts", { ...binding, choices: sampleChoices, references: other.references }),
      403, "FORBIDDEN");
    const invalid = await readResult(post(origin, path + "/drafts", {
      ...binding, choices: { ...sampleChoices, q2: "C" }, references,
    }), readingAnswerDraft);
    const submission = { ...binding, operationId: "turn-in", draft: invalid.draft };
    await assertError(post(origin, path + "/submissions", submission), 422, "INVALID_CHOICES");
    assert.equal((await readResult(get(origin, path), activityView)).step.id, "decide");
    const valid = await readResult(post(origin, path + "/drafts", {
      ...binding, workId: invalid.draft.id, choices: sampleChoices, references,
    }), readingAnswerDraft);
    assert.equal(valid.draft.version, 2);
    using database = new DatabaseSync(databasePath);
    const boundSource = database.prepare(`
      UPDATE practices SET definition = json_set(definition, '$.steps[1].submit.slots.basis.source', ?) WHERE id = ?
    `);
    const originalSource = reading.practice.steps[1]?.submit.slots.basis?.source;
    assert.ok(originalSource);
    boundSource.run("missing-source", reading.practice.id);
    await assertError(post(origin, path + "/submissions", { ...submission, draft: valid.draft }), 403, "FORBIDDEN");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evaluation_tasks").get()?.count, 0);
    boundSource.run(originalSource, reading.practice.id);
    database.exec(`
      CREATE TRIGGER fail_task BEFORE INSERT ON evaluation_tasks
      BEGIN SELECT RAISE(ABORT, 'test queue failure'); END;
    `);
    const request = { ...submission, draft: valid.draft };
    await assertError(post(origin, path + "/submissions", request), 500, "INTERNAL_ERROR");
    for (const table of ["evaluation_tasks", "completions"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions").get()?.count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM performances").get()?.count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_versions WHERE work_id = ?").get(valid.draft.id)?.count, 2);
    database.exec("DROP TRIGGER fail_task");
    await readResult(post(origin, path + "/submissions", request), submissionReceipt);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evaluation_tasks").get()?.count, 1);
  });
});

test("获准评阅者读取原引文和原答，选据评语独立保存且盲批学生不可读", async t => {
  await withReadingServer(t, async (origin, databasePath) => {
    const started = await startReading(origin);
    const review = `/api/reviews/${started.activityId}`;
    const path = `/api/activities/${started.activityId}`;
    const feedback = { text: "补充说明同期条件怎样影响解释。" };
    await assertError(get(origin, review), 403, "FORBIDDEN");
    await assertError(get(origin, review, "unassigned"), 403, "FORBIDDEN");
    await assertError(get(origin, path, "reviewer"), 403, "FORBIDDEN");
    await assertError(post(origin, review, feedback, "reviewer"), 409, "FEEDBACK_NOT_AVAILABLE");
    const source = await confirmSelection(origin, path, started.stepAttemptId, "quotes");
    const second = await readResult(get(origin, path), activityView);
    const binding = { stepAttemptId: second.stepAttemptId, slotId: "choices" };
    const draft = await readResult(post(origin, path + "/drafts", {
      ...binding, choices: sampleChoices, references: { basis: source.id },
    }), readingAnswerDraft);
    const receipt = await readResult(post(origin, path + "/submissions", {
      ...binding, operationId: "turn-in", draft: draft.draft,
    }), submissionReceipt);
    const quoteDetail = z.strictObject({ receipt: submissionReceipt, selection: readingSelection });
    const answerDetail = z.strictObject({ receipt: submissionReceipt, answer: readingAnswer });
    const reviewView = z.strictObject({
      activityId: z.uuid(),
      submissions: z.tuple([quoteDetail, answerDetail]),
      selectionFeedback: z.string().nullable(),
    });
    const view = await readResult(get(origin, review, "reviewer"), reviewView);
    assert.equal(view.selectionFeedback, null);
    assert.deepEqual(view.submissions[0].receipt, source);
    assert.deepEqual(view.submissions[1], { receipt, answer: draft.answer });
    assert.deepEqual(await readResult(post(origin, review, feedback, "reviewer"),
      z.strictObject({ selectionFeedback: z.string() })), { selectionFeedback: feedback.text });
    assert.equal((await readResult(get(origin, review, "reviewer"), reviewView)).selectionFeedback, feedback.text);
    const student = await get(origin, path);
    assert.equal(student.status, 200);
    const body = await student.text();
    assert.ok(!body.includes(feedback.text));
    assert.doesNotMatch(body, /"selectionFeedback"|"acceptedChoices"|"keyRef"|"correct"/);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT selection_feedback FROM reading_reviews WHERE activity_id = ?").get(started.activityId)?.selection_feedback, feedback.text);
    assert.equal(database.prepare("SELECT status FROM evaluation_tasks").get()?.status, "pending");
  });
});

test("旧引文沿用原表现，独立理由有新表现，成分不明的理由不另计", async t => {
  const [first, second] = reading.practice.steps;
  assert.ok(first && second?.submit.slots.choices);
  const assessment = {
    ...second, submit: { ...second.submit, slots: { ...second.submit.slots, choices: {
      ...second.submit.slots.choices, reasonTargetId: "explain",
    } } },
  };
  const publication = {
    ...reading, practice: {
      ...reading.practice, goals: { ...reading.practice.goals, explain: "说明提议的理由" }, steps: [first, assessment],
    },
  };
  const filename = temporaryPath(t);
  await runReadingServer(filename, publication, async origin => {
    using database = new DatabaseSync(filename, { readOnly: true });
    for (const independent of [true, false, undefined]) {
      const { started, path, binding, references } = await readyToAnswer(origin, String(independent));
      const sourceId = references.basis;
      const original = database.prepare("SELECT id FROM performances WHERE submission_id = ?").get(sourceId)?.id;
      assert.equal(typeof original, "string");
      const saved = await readResult(post(origin, path + "/drafts", {
        ...binding, choices: sampleChoices, references,
        reason: independent === undefined ? undefined : { text: "同时有别的学习地点关闭。", independent },
      }), readingAnswerDraft);
      const receipt = await readResult(post(origin, path + "/submissions", {
        ...binding, operationId: "turn-in", draft: saved.draft,
      }), submissionReceipt);
      const observed = database.prepare("SELECT id, target_id FROM performances WHERE submission_id = ?").all(receipt.id);
      assert.equal(observed.length, independent ? 4 : 3);
      assert.equal(observed.filter(row => row.target_id === "explain").length, independent ? 1 : 0);
      assert.deepEqual(database.prepare("SELECT id FROM performances WHERE submission_id = ?").all(sourceId).map(row => row.id), [original]);
      assert.equal(database.prepare("SELECT submission_id FROM completions WHERE activity_id = ?").get(started.activityId)?.submission_id, receipt.id);
    }
  });
});

test("盲批声明缩小范围后，活动和原提交只交付获准字段", async t => {
  const file = temporaryPath(t);
  const restricted = structuredClone(reading);
  restricted.practice.policy.student.ownSubmission.fields = ["ownChoices"];
  restricted.practice.policy.student.ownSubmission.onFinal = [];
  restricted.practice.policy.student.passageScore.fields = ["questionCount"];
  restricted.practice.policy.reviewer.actions = [];
  restricted.practice.policy.reviewer.fields = [];
  await runReadingServer(file, restricted, async origin => {
    const { path, binding, references } = await readyToAnswer(origin);
    const review = path.replace("/activities/", "/reviews/");
    await assertError(post(origin, review, { text: "未获准提交的评语" }, "reviewer"), 403, "FORBIDDEN");
    const saved = await readResult(post(origin, path + "/drafts", { ...binding, choices: sampleChoices, references }), readingAnswerDraft);
    const receipt = await readResult(post(origin, path + "/submissions", {
      ...binding, operationId: "turn-in", draft: saved.draft,
    }), submissionReceipt);
    const result = await readResult(get(origin, path), activityView.extend({ status: z.literal("completed") }));
    assert.equal(Object.values(result.inputs).map(input => z.object({ from: z.string() }).parse(input).from).includes("submission"), false);
    assert.deepEqual(result.submission, { answer: { choices: sampleChoices } });
    assert.equal("assessment" in result, false);
    assert.deepEqual(await readResult(get(origin, path + "/submissions/" + receipt.id), z.unknown()), result.submission);
    assert.deepEqual(await readResult(get(origin, path + "/submissions/" + references.basis), z.unknown()), {});
    using database = new DatabaseSync(file);
    evaluatePending(database, defaultRegistry);
    const delivered = await readResult(get(origin, path), z.object({ assessment: z.unknown() }));
    assert.deepEqual(delivered.assessment, { status: "complete", questionCount: 3 });
    const teacher = await get(origin, review, "reviewer");
    assert.equal(teacher.status, 200);
    assert.deepEqual(await teacher.json(), { activityId: result.activityId, submissions: [] });
  });
});

test("同名槽位的前序原答无需评估，服务只自动领取已绑定的后续交卷", async t => {
  const [evidence, decide] = reading.practice.steps;
  assert.ok(evidence && decide);
  const tentative = {
    ...decide,
    id: "tentative",
    afterConfirmation: "advance",
    inputs: { ...decide.inputs, passage: { from: "material", positionId: "tentative-position" } },
  };
  const publication = {
    ...reading,
    practice: { ...reading.practice, steps: [evidence, tentative, { ...decide, requires: tentative.id }] },
  };
  const file = temporaryPath(t);
  await runReadingServer(file, publication, async origin => {
    const first = await readyToAnswer(origin);
    const { path, references } = first;
    async function submitAnswers(binding: typeof first.binding, operationId: string) {
      const saved = await readResult(post(origin, path + "/drafts", { ...binding, choices: sampleChoices, references }), readingAnswerDraft);
      return readResult(post(origin, path + "/submissions", { ...binding, operationId, draft: saved.draft }), submissionReceipt);
    }
    const earlier = await submitAnswers(first.binding, "first-answers");
    using database = new DatabaseSync(file, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evaluation_tasks").get()?.count, 0);
    const finalStep = await readResult(get(origin, path), activityView);
    const final = await submitAnswers({ ...first.binding, stepAttemptId: finalStep.stepAttemptId }, "final-answers");
    const current = database.prepare("SELECT submission_id, status FROM evaluation_tasks");
    for (let attempt = 0; attempt < 40 && current.get()?.status !== "done"; attempt++) await delay(25);
    assert.deepEqual(current.all().map(row => [row.submission_id, row.status]), [[final.id, "done"]]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automatic_verdicts WHERE submission_id = ?").get(earlier.id)?.count, 0);
    assert.deepEqual((await readResult(get(origin, path), z.object({ assessment: z.unknown() }))).assessment,
      { status: "complete", correctCount: 1, questionCount: 3 });
  }, undefined, {});
});

test("服务启动后会话被移除，原地址再次读取返回 401", async t => {
  const sessions = new Map([["owner", "student-1"]]);
  await runReadingServer(temporaryPath(t), reading, async origin => {
    const activity = await startReading(origin);
    const path = "/api/activities/" + activity.activityId;
    await readResult(get(origin, path), activityView);
    sessions.delete("owner");
    await assertError(get(origin, path), 401, "UNAUTHENTICATED");
  }, sessions);
});

const sampleChoices = { q1: "A", q2: "B", q3: "A" };

async function readyToAnswer(origin: string, operationId = "start") {
  const started = await startReading(origin, operationId);
  const path = `/api/activities/${started.activityId}`;
  const source = await confirmSelection(origin, path, started.stepAttemptId, "quotes");
  const second = await readResult(get(origin, path), activityView);
  return {
    started, path,
    binding: { stepAttemptId: second.stepAttemptId, slotId: "choices" },
    references: { basis: source.id },
  };
}

async function withReadingServer(t: TestContext, run: (origin: string, path: string) => Promise<void>) {
  const path = temporaryPath(t);
  await runReadingServer(path, reading, origin => run(origin, path));
}

function temporaryPath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-progress-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "progress.sqlite");
}

async function runReadingServer<T>(
  path: string,
  publication: unknown,
  run: (origin: string) => Promise<T>,
  sessions = new Map([["owner", "student-1"], ["other", "student-2"]]),
  evaluation: { evaluateAutomatically?: boolean } = { evaluateAutomatically: false },
) {
  const server = createLearningServer({
    databasePath: path,
    publication,
    sessions,
    reviewerSessions: new Map([["reviewer", "teacher-1"], ["unassigned", "teacher-2"]]),
    assignedReviewer: "teacher-1",
    ...evaluation,
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function startReading(origin: string, operationId = "start", session = "owner") {
  return readResult(post(origin, "/api/activities", { practiceId: reading.practice.id, operationId }, session), startReceipt);
}

function post(origin: string, path: string, body: Record<string, unknown>, session = "owner") {
  return fetch(origin + path, {
    method: "POST",
    headers: { cookie: `learning_session=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, ...body }),
  });
}

function get(origin: string, path: string, session = "owner") {
  return fetch(origin + path, { headers: { cookie: `learning_session=${session}` } });
}

async function readResult<T>(request: Promise<Response>, contract: ZodType<T>) {
  const response = await request;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return contract.parse(JSON.parse(text));
}

async function assertError(request: Promise<Response>, status: number, code: string) {
  const response = await request;
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code });
}
