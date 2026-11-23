import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openLearningRuntime, ResponseConfirmationConflict } from "../src/server.ts";
import { latestDatabaseVersion } from "../src/kernel/database.ts";
import type {
  PublicationInput, ResponseConfirmationInput, ReviewAccess, ReviewScope,
  ResponseDraftInput, VerdictCommand, VerdictResult,
} from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";
import { booleanEvaluator, choiceEvaluator } from "./fixtures/evaluators.ts";
import { reviewAccess } from "./fixtures/evaluators.ts";

const student = { role: "student", id: "student" } as const;
const practice = { id: "frozen-judgment", version: 1 };
const evaluator = { id: "judge-source", version: 1 };
const question = { id: "judgment", version: 1, prompt: "判断这项说法", options: { yes: "对", no: "错" } };
const rawText = "  待教师辨认的判断文本  ";
const original = { state: "frozen", documentId: "work", versionId: "v2", sha256: "0".repeat(64) } as const;
const slotId = "answers";
const protocolVersion = 1;
const operationId = "confirm";

const oldPublication = {
  scoringKey: { ...practice, acceptedChoices: { [question.id]: "yes" } },
  practice: {
    ...practice, formatVersion: 1, title: "固定练习", goals: { answer: "已交答案" }, questions: [question],
    steps: [{
      id: "answer", instructions: "作答", tool: { id: "single-choice-group", version: 1 },
      inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { [slotId]: {
        type: "oneChoicePerQuestion", source: "questions", targetId: "answer",
        confirmFromDrafts: { allowUnanswered: true },
      } } },
      afterConfirmation: "finish",
    }],
    grading: { assessment: {
      evaluator, keyRef: practice, from: { stepId: "answer", slotId },
      effectiveVerdictOrder: ["teacherReview", "automatic"], unit: "question",
    } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownChoices"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  },
} satisfies PublicationInput;

const values = {
  booleanTrue: true, booleanFalse: false, textTrue: "true", textFalse: "false",
  unrecognized: rawText, emptyText: "", unanswered: null,
};
const keys = {
  booleanTrue: true, booleanFalse: false, textTrue: true, textFalse: false, unrecognized: true, emptyText: true, unanswered: true,
};
const ids = Object.keys(values) as (keyof typeof values)[];
const questions = ids.map(id => ({ ...question, id }));
const confirmedInput = { protocolVersion, slotId, operationId } as const;
type Runtime = ReturnType<typeof openLearningRuntime>;
type Opened = ReturnType<Runtime["start"]>;
type Settings = Parameters<typeof openLearningRuntime>[0];

function responsePublication(version = 1, fields: ("receipt" | "ownResponses")[] = ["receipt", "ownResponses"]) {
  const base = oldPublication.practice;
  const step = base.steps[0];
  const versionRef = { ...practice, version };
  return {
    scoringKey: { ...versionRef, acceptedResponses: Object.fromEntries(questions.map(({ id }) => [id, version === 1 ? keys[id] : !keys[id]])) },
    practice: {
      ...base, ...versionRef, questions: questions.map(item => ({ ...item, version })),
      steps: [{ ...step, tool: { id: "response-group", version: 1 }, submit: { ...step.submit, slots: { [slotId]: {
        ...step.submit.slots[slotId], type: "oneResponsePerQuestion", input: "booleanOrString",
      } } } }],
      policy: { ...base.policy, student: { ownSubmission: { ...base.policy.student.ownSubmission, fields } } },
      grading: { assessment: { ...base.grading.assessment, keyRef: versionRef } },
    },
  } satisfies PublicationInput;
}

const testEvaluator = ({ value, acceptedResponse }: { value: boolean | string | null; acceptedResponse: boolean }): VerdictResult => {
  if (value === null) return { status: "judged", correct: false };
  if (typeof value === "boolean") return { status: "judged", correct: value === acceptedResponse };
  if (value === "true" || value === "false") return { status: "judged", correct: (value === "true") === acceptedResponse };
  return { status: "needsReview" };
};

const registered = booleanEvaluator(evaluator, testEvaluator);
const trusted = ({ studentId, operationId: operation }: { studentId: string; operationId: string }) =>
  studentId === student.id && operation === operationId;

function opened(runtime: Runtime, version = 1) {
  return runtime.start(student, { protocolVersion, operationId: "start", practiceId: practice.id, practiceVersion: version });
}

function draft(open: Opened, questionId: string, value: string | boolean): ResponseDraftInput {
  return { protocolVersion, slotId, stepAttemptId: open.stepAttemptId, questionId, questionVersion: 1,
    value, operationId: "save", baseRevision: 0 };
}

function confirmation(open: Opened, selected: Partial<Record<keyof typeof values, number>> = {}): ResponseConfirmationInput {
  return { ...confirmedInput, stepAttemptId: open.stepAttemptId, questions: questions.map(({ id }) => ({
    questionId: id, questionVersion: 1, revision: selected[id] ?? 0, original: id === "unrecognized" ? original : { state: "uncollected" },
  })) };
}

function facts(path: string) {
  using database = new DatabaseSync(path, { readOnly: true });
  return { ...database.prepare(`
    SELECT (SELECT count(*) FROM submissions) AS submissions,
      (SELECT count(*) FROM completions) AS completions,
      (SELECT count(*) FROM performances) AS observations,
      (SELECT count(*) FROM evaluation_tasks WHERE status = 'pending') AS pendingTasks,
      (SELECT count(*) FROM evaluation_tasks WHERE status = 'done') AS evaluatedTasks,
      (SELECT count(*) FROM automatic_verdicts) AS judged,
      (SELECT count(*) FROM response_review_requirements) AS reviewRequired,
      (SELECT count(*) FROM works WHERE question_id IS NULL) AS confirmedWorks
  `).get() };
}

test("正式确认逐题原值，重开按原版返回同一回执、原稿和明确待评", t => {
  const databasePath = scenarioDatabase(t);
  let canRecover = true;
  const evaluations: unknown[] = [];
  const options: Settings = {
    databasePath,
    evaluators: [booleanEvaluator(evaluator, input => {
      evaluations.push(input.value);
      assert.deepEqual(input.practice, practice);
      assert.equal(input.questionVersion, 1);
      return testEvaluator(input);
    })],
    authorizeConfirmationRecovery: scope => canRecover && trusted(scope),
    verifyOriginal: scope => scope.original.state === "uncollected" ||
      (scope.original.state === "frozen" && scope.original.documentId === original.documentId
        && scope.original.versionId === original.versionId && scope.original.sha256 === original.sha256),
  };
  const runtime = openLearningRuntime(options);
  let open: Opened;
  let receipt: ReturnType<Runtime["confirmResponses"]>;
  let wire: ResponseConfirmationInput;
  try {
    runtime.publish(responsePublication());
    open = opened(runtime);
    for (const id of ids) {
      const value = values[id];
      if (value === null) continue;
      const request = draft(open, id, value);
      const saved = runtime.saveResponseDraft(student, open.activityId, request);
      assert.deepEqual(saved, { slotId, questionId: id, questionVersion: 1, value, revision: 1, changeCount: 1 });
      assert.deepEqual(runtime.saveResponseDraft(student, open.activityId, request, "replayLatestOnly"), saved);
    }
    const draftView = runtime.read(student, open.activityId);
    assert.ok("responseDrafts" in draftView);
    assert.equal(draftView.responseDrafts.length, 6);
    assert.deepEqual(draftView.responseDrafts.find(({ questionId }) => questionId === "unrecognized")?.value, rawText);
    assert.doesNotMatch(JSON.stringify(draftView), /scoringKey|acceptedResponses|needsReview/);
    runtime.publish(responsePublication(2));
    wire = confirmation(open, Object.fromEntries(ids.filter(id => values[id] !== null).map(id => [id, 1])));
    receipt = runtime.confirmResponses(student, open.activityId, wire);
    assert.deepEqual(runtime.confirmResponses(student, open.activityId, { ...wire, questions: wire.questions.toReversed() }), receipt);
    assert.throws(() => runtime.confirmResponses(student, open.activityId, { ...wire, operationId: "new-confirm" }),
      { status: 409, code: "ALREADY_SUBMITTED" });
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, observations: 6, pendingTasks: 1,
      evaluatedTasks: 0, judged: 0, reviewRequired: 0, confirmedWorks: 1 });
    assert.deepEqual(evaluations, []);
  } finally {
    runtime.close();
  }
  const reopened = openLearningRuntime(options);
  let stored: ReturnType<Runtime["recoverResponseConfirmation"]>;
  try {
    const key = { protocolVersion, operationId, stepAttemptId: open.stepAttemptId } as const;
    assert.throws(() => reopened.recoverResponseConfirmation({ ...student, id: "other" }, open.activityId, key), { status: 403, code: "FORBIDDEN" });
    canRecover = false;
    assert.throws(() => reopened.recoverResponseConfirmation(student, open.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.deepEqual(evaluations, []);
    canRecover = true;
    assert.deepEqual(reopened.recoverResponseConfirmation(student, open.activityId, key).evaluation, { status: "pending", evaluator });
    assert.deepEqual(evaluations, []);
    assert.deepEqual(reopened.evaluatePending(), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
    stored = reopened.recoverResponseConfirmation(student, open.activityId, key);
    assert.deepEqual(stored.receipt, receipt);
    assert.deepEqual(stored.practice, practice);
    assert.deepEqual(stored.confirmation.questions.map(({ questionId, value }) => [questionId, value]), ids.map(id => [id, values[id]]));
    assert.deepEqual(stored.confirmation.questions.find(({ questionId }) => questionId === "unrecognized")?.original, original);
    assert.deepEqual(stored.responseDraftChangeCounts, ids.map(questionId => ({ questionId, changeCount: values[questionId] === null ? 0 : 1 })));
    assert.deepEqual(stored.evaluation, { status: "evaluated", evaluator, questionCount: 7, correctCount: 4, needsReviewCount: 2, questions: ids.map(questionId => ({
      questionId, questionVersion: 1, result: testEvaluator({ value: values[questionId], acceptedResponse: keys[questionId] }),
    })) });
    assert.deepEqual(evaluations, ids.map(id => values[id]));
    assert.doesNotMatch(JSON.stringify(stored), /scoringKey|acceptedResponses|acceptedResponse/);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, observations: 6, pendingTasks: 0,
      evaluatedTasks: 1, judged: 5, reviewRequired: 2, confirmedWorks: 1 });
    const studentView = reopened.read(student, open.activityId);
    assert.ok("formatVersion" in studentView);
    assert.deepEqual(studentView.submission, { receipt, responseConfirmation: stored.confirmation });
    assert.doesNotMatch(JSON.stringify(studentView), /scoringKey|acceptedResponse|correctCount|needsReview/);
    canRecover = false;
    assert.throws(() => reopened.recoverResponseConfirmation(student, open.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => reopened.read({ ...student, id: "other" }, open.activityId), { status: 403, code: "FORBIDDEN" });
    assert.equal(evaluations.length, 7);
  } finally {
    reopened.close();
  }
  const durable = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: trusted });
  try {
    const key = { protocolVersion, operationId, stepAttemptId: open.stepAttemptId } as const;
    assert.deepEqual(durable.recoverResponseConfirmation(student, open.activityId, key), stored);
    assert.deepEqual(durable.confirmResponses(student, open.activityId, wire), receipt);
  } finally {
    durable.close();
  }
});

test("只有显式原值声明与精确注册的评估器才允许发布", t => {
  const databasePath = scenarioDatabase(t);
  const builtin = { id: "choice-key", version: 1 };
  assert.throws(() => openLearningRuntime({ databasePath, evaluators: [choiceEvaluator(builtin, () => true)] }), /评估器重复登记/);
  assert.throws(() => openLearningRuntime({ databasePath, evaluators: [booleanEvaluator(builtin, testEvaluator)] }), /评估器重复登记/);
  const wrong = openLearningRuntime({ databasePath, evaluators: [choiceEvaluator(evaluator, () => true)] });
  try {
    assert.throws(() => wrong.publish(responsePublication()), { name: "ZodError" });
  } finally {
    wrong.close();
  }
  const runtime = openLearningRuntime({ databasePath, evaluators: [registered] });
  try {
    const publication = responsePublication();
    const step = publication.practice.steps[0];
    assert.ok(step);
    assert.throws(() => runtime.publish({ ...publication, practice: {
      ...publication.practice, steps: [{ ...step, tool: { id: "single-choice-group", version: 1 } }],
    } }), { name: "ZodError" });
    assert.throws(() => runtime.publish({ ...publication, scoringKey: oldPublication.scoringKey }), { name: "ZodError" });
    assert.throws(() => runtime.publish({ ...publication, scoringKey: { ...publication.scoringKey, acceptedResponses: {} } }), { name: "ZodError" });
    assert.throws(() => runtime.publish({ ...publication,
      scoringKey: { ...publication.scoringKey, acceptedResponses: {} },
      practice: { ...publication.practice, questions: [{ ...question, id: "constructor" }] },
    }), { name: "ZodError" });
    assert.throws(() => runtime.publish({ ...publication, practice: {
      ...publication.practice, grading: { assessment: { ...publication.practice.grading.assessment, evaluator: { ...evaluator, version: 2 } } },
    } }), { name: "ZodError" });
    assert.throws(() => runtime.publish({ ...publication, practice: {
      ...publication.practice, questions: questions.map(({ version, ...rest }) => rest),
    } }), { name: "ZodError" });
    runtime.publish(publication);
    assert.throws(() => runtime.publish({ ...publication, scoringKey: { ...publication.scoringKey, acceptedResponses: { ...keys, booleanTrue: false } } }),
      /已发布/);
  } finally {
    runtime.close();
  }
});

test("原值草稿保护操作、冻结版本和原稿条件，拒绝旧槽接口交叉读取", t => {
  const runtime = openLearningRuntime({ databasePath: scenarioDatabase(t), evaluators: [registered],
    authorizeConfirmationRecovery: trusted, verifyOriginal: scope => scope.original.state === "uncollected" });
  try {
    runtime.publish(responsePublication());
    const open = opened(runtime);
    const input = draft(open, "unrecognized", rawText);
    assert.throws(() => runtime.saveResponseDraft(student, open.activityId, { ...input, questionVersion: 2 }),
      { status: 409, code: "QUESTION_REVISION_STALE" });
    assert.throws(() => Reflect.apply(runtime.saveResponseDraft, runtime, [student, open.activityId, { ...input, value: 0 }]),
      { status: 422, code: "INVALID_RESPONSE" });
    const saved = runtime.saveResponseDraft(student, open.activityId, input);
    assert.equal(saved.revision, 1);
    assert.throws(() => runtime.saveResponseDraft(student, open.activityId, { ...input, value: rawText.trim() }),
      { status: 409, code: "OPERATION_CONFLICT", current: { revision: 1, value: rawText } });
    assert.throws(() => runtime.saveResponseDraft(student, open.activityId, { ...input, operationId: "concurrent", value: true }),
      { status: 409, code: "ANSWER_REVISION_CONFLICT", current: { revision: 1, value: rawText } });
    const { value, ...scope } = input;
    assert.throws(() => runtime.saveChoiceDraft(student, open.activityId, { ...scope, choice: "yes" }), { status: 422, code: "INVALID_SLOT" });
    assert.throws(() => runtime.confirmChoices(student, open.activityId, confirmation(open, { unrecognized: 1 })),
      { status: 422, code: "INVALID_SLOT" });
    const edited = { ...input, value: false, baseRevision: 1, operationId: "edit" };
    const second = runtime.saveResponseDraft(student, open.activityId, edited);
    assert.deepEqual(second, { ...saved, value: false, revision: 2, changeCount: 2 });
    const same = { ...edited, baseRevision: 2, operationId: "same" };
    assert.deepEqual(runtime.saveResponseDraft(student, open.activityId, same), second);
    assert.deepEqual(runtime.saveResponseDraft(student, open.activityId, same, "replayLatestOnly"), second);
    assert.throws(() => runtime.saveResponseDraft(student, open.activityId, edited, "replayLatestOnly"),
      { status: 409, code: "OPERATION_CONFLICT", current: { revision: 2, value: false } });
    assert.throws(() => runtime.saveResponseDraft(student, open.activityId, { ...same, operationId: "unknown" }, "replayLatestOnly"),
      { status: 409, code: "DRAFT_REPLAY_REQUIRED" });
    assert.throws(() => runtime.confirmResponses(student, open.activityId, confirmation(open)), error => {
      assert.ok(error instanceof ResponseConfirmationConflict);
      assert.equal(error.code, "ANSWER_REVISION_CONFLICT");
      assert.equal(error.questionId, "unrecognized");
      assert.deepEqual(error.current, { revision: 2, value: false });
      return true;
    });
    assert.throws(() => runtime.confirmResponses(student, open.activityId, confirmation(open, { unrecognized: 2 })),
      { status: 409, code: "ORIGINAL_NOT_VERIFIED" });
    assert.throws(() => runtime.recoverResponseConfirmation(student, open.activityId, {
      protocolVersion, operationId, stepAttemptId: open.stepAttemptId,
    }), { status: 404, code: "CONFIRMATION_NOT_FOUND" });
  } finally {
    runtime.close();
  }
});

test("确认事务失败不泄漏完成或必要任务，重试同操作后评估失败也可恢复", t => {
  const databasePath = scenarioDatabase(t);
  const options: Settings = { databasePath, evaluators: [registered],
    authorizeConfirmationRecovery: trusted, verifyOriginal: () => true };
  const runtime = openLearningRuntime(options);
  try {
    runtime.publish(responsePublication(1, ["receipt"]));
    const open = opened(runtime);
    runtime.saveResponseDraft(student, open.activityId, draft(open, "unrecognized", rawText));
    const wire = confirmation(open, { unrecognized: 1 });
    using database = new DatabaseSync(databasePath);
    database.exec(`CREATE TRIGGER fail_task BEFORE INSERT ON evaluation_tasks BEGIN SELECT RAISE(ABORT, 'task write'); END`);
    assert.throws(() => runtime.confirmResponses(student, open.activityId, wire), /task write/);
    assert.deepEqual(facts(databasePath), { submissions: 0, completions: 0, observations: 0, pendingTasks: 0,
      evaluatedTasks: 0, judged: 0, reviewRequired: 0, confirmedWorks: 0 });
    database.exec("DROP TRIGGER fail_task");
    const receipt = runtime.confirmResponses(student, open.activityId, wire);
    assert.deepEqual(runtime.confirmResponses(student, open.activityId, wire), receipt);
    const studentView = runtime.read(student, open.activityId);
    assert.ok("formatVersion" in studentView);
    assert.deepEqual(studentView.submission, { receipt });
    const key = { protocolVersion, operationId, stepAttemptId: open.stepAttemptId } as const;
    const missing = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: trusted });
    try {
      assert.deepEqual(missing.evaluatePending(), { evaluated: 0, retrying: 0, failed: 0, deferred: 1 });
      assert.deepEqual(missing.recoverResponseConfirmation(student, open.activityId, key).evaluation, { status: "pending", evaluator });
    } finally {
      missing.close();
    }
    database.exec(`CREATE TRIGGER fail_verdict BEFORE INSERT ON automatic_verdicts BEGIN SELECT RAISE(ABORT, 'verdict write'); END`);
    assert.throws(() => runtime.evaluatePending(), /verdict write/);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, observations: 1, pendingTasks: 1,
      evaluatedTasks: 0, judged: 0, reviewRequired: 0, confirmedWorks: 1 });
    database.exec("DROP TRIGGER fail_verdict");
    assert.deepEqual(runtime.evaluatePending(), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
    const recovered = runtime.recoverResponseConfirmation(student, open.activityId, key);
    assert.deepEqual(recovered.receipt, receipt);
    assert.ok(recovered.evaluation.status === "evaluated");
    assert.deepEqual(recovered.evaluation.questions.find(({ questionId }) => questionId === "unrecognized")?.result, { status: "needsReview" });
    database.prepare("DELETE FROM response_review_requirements WHERE submission_id = ?").run(receipt.id);
    assert.throws(() => runtime.recoverResponseConfirmation(student, open.activityId, key), /缺少判定或待评事实/);
  } finally {
    runtime.close();
  }
});

test("v15 已声明单选的活动升级后保持成员校验、原回执和布尔判定", t => {
  const databasePath = scenarioDatabase(t);
  const options = { databasePath, authorizeConfirmationRecovery: trusted,
    evaluators: [choiceEvaluator(evaluator, () => true)], verifyOriginal: () => true };
  const old = openLearningRuntime(options);
  let open: Opened;
  let receipt: ReturnType<Runtime["confirmChoices"]>;
  try {
    old.publish(oldPublication);
    open = opened(old);
    const { value, ...scope } = draft(open, question.id, true);
    assert.throws(() => old.saveCurrentChoiceDraft(student, open.activityId, { ...scope, choice: rawText }),
      { status: 422, code: "INVALID_CHOICE" });
    assert.throws(() => old.saveResponseDraft(student, open.activityId, { ...scope, value }), { status: 422, code: "INVALID_SLOT" });
    const saved = old.saveCurrentChoiceDraft(student, open.activityId, { ...scope, choice: "yes" });
    receipt = old.confirmChoices(student, open.activityId, { ...confirmedInput, stepAttemptId: open.stepAttemptId, questions: [
      { questionId: question.id, questionVersion: 1, revision: saved.revision, original },
    ] });
    old.evaluatePending();
    const choiceRecovery = old.recoverChoiceConfirmation(student, open.activityId, {
      protocolVersion, operationId, stepAttemptId: open.stepAttemptId,
    });
    assert.ok(choiceRecovery.evaluation?.status === "evaluated");
    assert.equal(choiceRecovery.evaluation.questions[0]?.correct, true);
  } finally {
    old.close();
  }
  {
    using database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE prepared_activity_version_changes DROP COLUMN intent;
      DROP TABLE response_review_requirements;
      DELETE FROM schema_migrations WHERE version > 15;
    `);
  }
  const upgraded = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: trusted });
  try {
    const key = { protocolVersion, operationId, stepAttemptId: open.stepAttemptId } as const;
    const restored = upgraded.recoverChoiceConfirmation(student, open.activityId, key);
    assert.deepEqual(restored.receipt, receipt);
    assert.deepEqual(restored.confirmation.questions[0], { questionId: question.id, questionVersion: 1, revision: 1, original, choice: "yes" });
    assert.ok(restored.evaluation?.status === "evaluated");
    assert.equal(restored.evaluation?.questions[0]?.correct, true);
    assert.throws(() => upgraded.recoverResponseConfirmation(student, open.activityId, key), { status: 404, code: "CONFIRMATION_NOT_FOUND" });
    using database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, latestDatabaseVersion);
    assert.equal(database.prepare("PRAGMA foreign_key_check").get(), undefined);
  } finally {
    upgraded.close();
  }
});

test("标量正式确认的连续改判逐次撤销回落到上一条有效判定，保留原判、待评和回执并按当前权限重发", t => {
  const databasePath = scenarioDatabase(t);
  const reviewer = { role: "reviewer", id: "judge-teacher" } as const;
  const mode = "responseConfirmation";
  const denied = { status: 403, code: "FORBIDDEN" };
  const notFound = { status: 404, code: "REVIEW_NOT_FOUND" };
  const conflict = { status: 409, code: "VERDICT_CONFLICT" };
  const questionVersion = 2;
  const targetId = "answer";
  const allowedQuestions = ["booleanFalse", "unrecognized"];
  const { activityId, key, wire, receipt, otherReceipt, originalRecovery, studentView } = (() => {
    const runtime = openLearningRuntime({ databasePath, evaluators: [registered],
      authorizeConfirmationRecovery: trusted, verifyOriginal: () => true,
    });
    try {
      runtime.publish(responsePublication(questionVersion));
      const activity = opened(runtime, questionVersion);
      const key = { protocolVersion, operationId, stepAttemptId: activity.stepAttemptId } as const;
      const wire = confirmation(activity, { booleanFalse: 1, unrecognized: 1 });
      for (const position of wire.questions) position.questionVersion = questionVersion;
      for (const [id, value] of [["booleanFalse", false], ["unrecognized", rawText]] as const) {
        runtime.saveResponseDraft(student, activity.activityId, { ...draft(activity, id, value), questionVersion });
      }
      const receipt = runtime.confirmResponses(student, activity.activityId, wire);
      runtime.evaluatePending();
      const other = runtime.start(student, { protocolVersion, operationId: "start-other", practiceId: practice.id, practiceVersion: questionVersion });
      const otherReceipt = runtime.confirmResponses(student, other.activityId, { ...wire, stepAttemptId: other.stepAttemptId,
        questions: wire.questions.map(position => ({ ...position, revision: 0 })),
      });
      runtime.evaluatePending();
      return { activityId: activity.activityId, key, wire, receipt, otherReceipt,
        originalRecovery: runtime.recoverResponseConfirmation(student, activity.activityId, key), studentView: runtime.read(student, activity.activityId),
      };
    } finally { runtime.close(); }
  })();
  const command: VerdictCommand = { protocolVersion, operationId: "mark-original", submissionId: receipt.id,
    targetId, questionId: "booleanFalse", expectedRevision: 0, action: "override", correct: true, reason: "核对冻结判断",
  };
  let readAllowed = true;
  let writeAllowed = true;
  const ownsReview = (scope: ReviewScope) => scope.reviewerId === reviewer.id && scope.studentId === student.id
    && scope.activityId === activityId && scope.stepAttemptId === key.stepAttemptId && scope.operationId === key.operationId
    && scope.submissionId === receipt.id && scope.slotId === receipt.slotId;
  const authorizeReview = reviewAccess({ responseConfirmation: {
    read: scope => readAllowed && ownsReview(scope),
    write: (scope: Extract<ReviewAccess, { purpose: "reviseVerdict" }>) => writeAllowed && ownsReview(scope)
      && scope.targetId === targetId && scope.questionVersion === questionVersion && allowedQuestions.includes(scope.questionId),
  } });
  const isolatedPolicies = { databasePath, authorizeConfirmationRecovery: trusted, authorizeReview: reviewAccess({
    questionDelivery: { read: () => true, write: () => true }, choiceConfirmation: { read: () => true, write: () => true },
  }) };
  const oldModes = openLearningRuntime(isolatedPolicies);
  try {
    assert.throws(() => oldModes.readQuestionDeliveryReview(reviewer, activityId, key, mode), denied);
    assert.throws(() => oldModes.writeQuestionDeliveryVerdict(reviewer, activityId, key, command, mode), denied);
    assert.throws(() => oldModes.readQuestionDeliveryReview(reviewer, activityId, key), notFound);
    assert.throws(() => oldModes.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts"), notFound);
    assert.throws(() => oldModes.readQuestionDeliveryReview(reviewer, activityId, key, "choiceConfirmation"), notFound);
    assert.throws(() => oldModes.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), denied);
    assert.throws(() => oldModes.writeQuestionDeliveryVerdict(reviewer, activityId, key, command, "choiceConfirmation"), denied);
  } finally { oldModes.close(); }

  const stableFacts = facts(databasePath);
  const settings = { databasePath, authorizeConfirmationRecovery: trusted, authorizeReview };
  const runtime = openLearningRuntime(settings);
  const { final, replay } = (() => {
    try {
      const read = () => runtime.readQuestionDeliveryReview(reviewer, activityId, key, mode);
      const write = (change: VerdictCommand) => runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, change, mode);
      const first = read();
      assert.deepEqual(first.receipt, receipt);
      assert.deepEqual(first.confirmation, originalRecovery.confirmation);
      assert.equal(first.targetId, targetId);
      assert.equal(first.assessment, "automatic");
      assert.doesNotMatch(JSON.stringify(first), /scoringKey|acceptedResponses|acceptedResponse/);
      const base = first.questions.filter(item => allowedQuestions.includes(item.questionId));
      assert.deepEqual(base, [
        { questionId: "booleanFalse", questionVersion, revision: 0, status: "judged", automatic: { correct: false, valid: true },
          effective: { source: "automatic", correct: false } },
        { questionId: "unrecognized", questionVersion, revision: 0, status: "needsReview" },
      ]);
      assert.throws(() => runtime.readQuestionDeliveryReview({ ...reviewer, id: "outside" }, activityId, key, mode), denied);
      assert.throws(() => runtime.writeQuestionDeliveryVerdict({ ...reviewer, id: "outside" }, activityId, key, command, mode), denied);
      assert.throws(() => Reflect.apply(runtime.readQuestionDeliveryReview, runtime, [student, activityId, key, mode]), denied);
      assert.throws(() => Reflect.apply(runtime.writeQuestionDeliveryVerdict, runtime, [student, activityId, key, command, mode]), denied);
      assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activityId, { ...key, operationId: "different" }, mode), denied);
      for (const changed of [{ submissionId: otherReceipt.id }, { targetId: "wrong-target" }, { questionId: "outside" }, { questionId: "booleanTrue" }]) {
        assert.throws(() => write({ ...command, ...changed }), denied);
      }
      const replay = base.flatMap(({ questionId }) => {
        const firstMark = { ...command, questionId, operationId: `first-${questionId}` };
        const firstReceipt = write(firstMark);
        assert.equal(firstReceipt.revision, 1);
        assert.deepEqual(write(firstMark), firstReceipt);
        assert.throws(() => write({ ...firstMark, reason: "异文重试" }), { status: 409, code: "OPERATION_CONFLICT" });
        assert.throws(() => write({ ...firstMark, operationId: `stale-${questionId}` }), conflict);
        const nextMark = { ...firstMark, expectedRevision: 1, operationId: `next-${questionId}`, correct: false };
        const nextReceipt = write(nextMark);
        const standing = read().questions.find(item => item.questionId === questionId);
        assert.ok(standing?.status === "judged");
        assert.deepEqual(standing.effective, { source: "teacherReview", id: nextReceipt.id, correct: false });
        const clear: VerdictCommand = { protocolVersion, targetId, submissionId: receipt.id, questionId, reason: "清除当前判定",
          action: "withdraw", withdrawId: nextReceipt.id, expectedRevision: 2, operationId: `clear-${questionId}`,
        };
        assert.throws(() => write({ ...clear, withdrawId: firstReceipt.id }), conflict);
        const cleared = write(clear);
        assert.deepEqual(write(clear), cleared);
        const fallback = read().questions.find(item => item.questionId === questionId);
        assert.ok(fallback?.status === "judged");
        assert.deepEqual(fallback.effective, { source: "teacherReview", id: firstReceipt.id, correct: true });
        const revert: VerdictCommand = { ...clear, withdrawId: firstReceipt.id, expectedRevision: 3, operationId: `revert-${questionId}` };
        const reverted = write(revert);
        assert.equal(reverted.revision, 4);
        return [[firstMark, firstReceipt], [nextMark, nextReceipt], [clear, cleared], [revert, reverted]] as const;
      });
      const final = read();
      assert.deepEqual(final.questions, first.questions.map(item => allowedQuestions.includes(item.questionId) ? { ...item, revision: 4 } : item));
      assert.deepEqual(runtime.read(student, activityId), studentView);
      assert.deepEqual(runtime.recoverResponseConfirmation(student, activityId, key), originalRecovery);
      return { final, replay };
    } finally { runtime.close(); }
  })();
  const reopened = openLearningRuntime(settings);
  try {
    assert.deepEqual(reopened.readQuestionDeliveryReview(reviewer, activityId, key, mode), final);
    for (const [request, previous] of replay) {
      assert.deepEqual(reopened.writeQuestionDeliveryVerdict(reviewer, activityId, key, request, mode), previous);
    }
    readAllowed = false;
    assert.throws(() => reopened.readQuestionDeliveryReview(reviewer, activityId, key, mode), denied);
    readAllowed = true;
    writeAllowed = false;
    for (const [request] of replay) {
      assert.throws(() => reopened.writeQuestionDeliveryVerdict(reviewer, activityId, key, request, mode), denied);
    }
    assert.deepEqual(reopened.readQuestionDeliveryReview(reviewer, activityId, key, mode), final);
    assert.deepEqual(reopened.confirmResponses(student, activityId, wire), receipt);
    assert.deepEqual(reopened.recoverResponseConfirmation(student, activityId, key), originalRecovery);
    assert.deepEqual(facts(databasePath), stableFacts);
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verdict_events WHERE submission_id = ?").get(receipt.id)?.count, 8);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verdict_events").get()?.count, 8);
  } finally { reopened.close(); }
});
