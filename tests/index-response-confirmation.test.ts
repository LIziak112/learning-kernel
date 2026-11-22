import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { readPersonalDraft } from "../src/kernel/work-versions.ts";
import { IndexResponseDraftConflict, openLearningRuntime } from "../src/server.ts";
import type { IndexResponseEvaluator, PublicationInput, ResponseConfirmationInput } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "index-learner" } as const;
const outsider = { ...student, id: "other-learner" };
const protocolVersion = 1;
const evaluator = { id: "index-set-evaluator", version: 1 };
const questions = ["selected", "empty", "absent", "wrong"].map((id, ordinal) => ({
  id, version: ordinal + 1, prompt: "选择符合条件的项目。",
  options: { "0": "红", "1": "绿", "2": "蓝", "3": "白" },
}));

function publication(version = 1, selected = [0, 2], allowUnanswered = true, ownResponseFields: ("receipt" | "ownResponses")[] = ["receipt", "ownResponses"]) {
  const key = { id: "indexed-key", version };
  return {
    practice: {
      id: "indexed-practice", version, formatVersion: 1, title: "索引作答",
      goals: { answer: "确认作答" }, questions,
      steps: [{ id: "answer", instructions: "选择所有符合条件的项目。", tool: { id: "response-group", version: 1 },
        inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { answers: {
          type: "oneResponsePerQuestion", input: "optionIndexArray", source: "questions", targetId: "answer",
          confirmFromDrafts: { allowUnanswered },
        } } }, afterConfirmation: "finish",
      }],
      grading: { assessment: { from: { slotId: "answers", stepId: "answer" }, evaluator, keyRef: key,
        unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
      } },
      policy: { offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ownResponseFields, onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
      },
    },
    scoringKey: { ...key, acceptedIndexes: { selected, empty: [0], absent: [1], wrong: [1, 2] } },
  } satisfies PublicationInput;
}

function opening(practiceVersion = 1, operationId = "open") {
  return { protocolVersion, practiceId: "indexed-practice", practiceVersion, operationId } as const;
}

type Runtime = ReturnType<typeof openLearningRuntime>;

function draft(runtime: Runtime, activity: ReturnType<Runtime["start"]>, index: number, value: number[], operationId: string, baseRevision = 0) {
  const question = questions[index];
  assert.ok(question);
  return runtime.saveIndexResponseDraft(student, activity.activityId, {
    protocolVersion, stepAttemptId: activity.stepAttemptId, slotId: "answers", questionId: question.id,
    questionVersion: question.version, operationId, baseRevision, value,
  });
}

function rowCounts(databasePath: string) {
  using db = new DatabaseSync(databasePath, { readOnly: true });
  return ["submissions", "completions", "evaluation_tasks", "performances", "automatic_verdicts"]
    .map(table => db.prepare("SELECT count(*) AS n FROM " + table).get()?.n);
}

test("公布索引数组时须注册准确模式的评价器，失败后练法无法开卷", t => {
  const runtime = openLearningRuntime({ databasePath: scenarioDatabase(t),
    responseEvaluators: [{ ...evaluator, evaluate: () => ({ status: "judged", correct: true }) }],
  });
  try {
    assert.throws(() => runtime.publish(publication()), error => error instanceof ZodError &&
      error.issues.some(issue => issue.path.join(".") === "practice.grading.assessment.evaluator"));
    assert.throws(() => runtime.start(student, opening()), { status: 404, code: "PRACTICE_NOT_FOUND" });
  } finally { runtime.close(); }
});

test("公开发布拒绝超出冻结选项、不完整的私有键及不连续的选项编号", t => {
  const runtime = openLearningRuntime({ databasePath: scenarioDatabase(t),
    indexResponseEvaluators: [{ ...evaluator, evaluate: () => ({ status: "judged", correct: false }) }],
  });
  try {
    const valid = publication();
    const cases = [
      [publication(1, [4]), "scoringKey.acceptedIndexes.selected"],
      [{ ...valid, scoringKey: { ...valid.scoringKey, acceptedIndexes: { empty: [0] } } }, "scoringKey.acceptedIndexes.selected"],
      [{ ...valid, scoringKey: { ...valid.scoringKey, acceptedIndexes: { ...valid.scoringKey.acceptedIndexes, extra: [0] } } }, "scoringKey.acceptedIndexes.extra"],
      [{ ...valid, scoringKey: { id: valid.scoringKey.id, version: 1, acceptedResponses: { selected: true } } }, "scoringKey"],
      [{ ...valid, practice: { ...valid.practice, questions: valid.practice.questions.map(q =>
        q.id === "selected" ? { ...q, options: { "0": "甲", "2": "乙" } } : q) } }, "practice.questions.0.options"],
    ] as const;
    for (const [candidate, path] of cases) {
      assert.throws(() => Reflect.apply(runtime.publish, runtime, [candidate]), error => error instanceof ZodError &&
        error.issues.some(issue => issue.path.join(".") === path));
      assert.throws(() => runtime.start(student, opening()), { status: 404, code: "PRACTICE_NOT_FOUND" });
    }
    runtime.publish(valid);
    assert.ok(runtime.start(student, opening()).activityId);
  } finally { runtime.close(); }
});

test("不允许未作答时显式空选仍保稿，确认后依声明限制作品读面", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath,
    indexResponseEvaluators: [{ ...evaluator, evaluate: () => ({ status: "judged", correct: false }) }],
  });
  try {
    runtime.publish(publication(1, [0, 2], false, ["receipt"]));
    const activity = runtime.start(student, opening());
    const drafts = questions.map((_, index) => draft(runtime, activity, index, index === 0 ? [] : [0], "draft-" + index));
    const input = (operationId: string): ResponseConfirmationInput => ({ protocolVersion, stepAttemptId: activity.stepAttemptId, operationId, slotId: "answers",
      questions: drafts.map(({ questionId, questionVersion, revision }) => ({
        questionId, questionVersion, revision, original: { state: "uncollected" as const },
      })),
    });
    assert.throws(() => runtime.confirmIndexResponses(student, activity.activityId, input("blank-rejected")),
      { status: 422, code: "UNANSWERED_QUESTION" });
    assert.deepEqual(rowCounts(databasePath), [0, 0, 0, 0, 0]);
    const saved = runtime.read(student, activity.activityId);
    assert.ok("indexResponseDrafts" in saved);
    assert.deepEqual(saved.indexResponseDrafts.find(item => item.questionId === "selected")?.value, []);
    drafts[0] = draft(runtime, activity, 0, [0], "replace-blank", 1);
    const receipt = runtime.confirmIndexResponses(student, activity.activityId, input("completed"));
    const done = runtime.read(student, activity.activityId);
    assert.ok("formatVersion" in done);
    assert.deepEqual(done.submission, { receipt });
    using db = new DatabaseSync(databasePath, { readOnly: true });
    const confirmedWork = db.prepare("SELECT work_id FROM submissions WHERE id = ?").get(receipt.id)?.work_id;
    assert.ok(typeof confirmedWork === "string");
    assert.throws(() => readPersonalDraft(db, student.id, confirmedWork), { status: 403, code: "FORBIDDEN" });
  } finally { runtime.close(); }
});

test("公开索引数组整卷区分空选与无稿，冻结原值和私有评分集合并重开取回同一结果", t => {
  const databasePath = scenarioDatabase(t);
  let permitted = true;
  let failedEvaluation = false;
  const observed: Array<{ value: readonly number[] | null; acceptedIndexes: readonly number[] }> = [];
  const evaluate: IndexResponseEvaluator = ({ questionId, value, acceptedIndexes }) => {
    if (failedEvaluation && questionId === "empty") throw new Error("评价暂不可用");
    if (!failedEvaluation) observed.push({ value, acceptedIndexes });
    const picked = new Set(value);
    const correct = picked.size > 0 && picked.size === new Set(acceptedIndexes).size && acceptedIndexes.every(item => picked.has(item));
    return { status: "judged", correct };
  };
  const settings = { databasePath, indexResponseEvaluators: [{ ...evaluator, evaluate }],
    authorizeConfirmationRecovery: ({ studentId }: { studentId: string }) => permitted && studentId === student.id,
    authorizeResponseConfirmationReview: () => true, authorizeResponseConfirmationVerdict: () => true,
  };
  const runtime = openLearningRuntime(settings);
  let activity: ReturnType<Runtime["start"]>;
  let receipt: ReturnType<Runtime["confirmIndexResponses"]>;
  let key: { protocolVersion: 1; operationId: string; stepAttemptId: string };
  try {
    runtime.publish(publication());
    activity = runtime.start(student, opening());
    const original = draft(runtime, activity, 0, [2, 0, 2], "first");
    assert.deepEqual(draft(runtime, activity, 0, [2, 0, 2], "first"), original);
    assert.deepEqual(draft(runtime, activity, 0, [2, 0, 2], "same-next", 1), original);
    assert.throws(() => draft(runtime, activity, 0, [2, 2, 0], "same-next", 1), { status: 409, code: "OPERATION_CONFLICT" });
    assert.throws(() => draft(runtime, activity, 0, [0, 2], "stale", 0), { status: 409, code: "ANSWER_REVISION_CONFLICT" });
    assert.throws(() => draft(runtime, activity, 0, [-1], "negative", 1), { name: "ZodError" });
    assert.throws(() => draft(runtime, activity, 0, [4], "out-of-range", 1), { status: 422, code: "INVALID_OPTION_INDEX" });
    const empty = draft(runtime, activity, 1, [], "empty");
    const wrong = draft(runtime, activity, 3, [0], "wrong");
    const current = runtime.read(student, activity.activityId);
    assert.ok("indexResponseDrafts" in current);
    assert.deepEqual(current.indexResponseDrafts.map(item => item.value), [[], [2, 0, 2], [0]]);
    assert.equal("responseDrafts" in current, false);
    assert.doesNotMatch(JSON.stringify(current), /acceptedIndexes|acceptedResponses|scoringKey/);
    assert.throws(() => runtime.saveResponseDraft(student, activity.activityId, {
      protocolVersion, stepAttemptId: activity.stepAttemptId, slotId: "answers", questionId: original.questionId,
      questionVersion: 1, operationId: "wrong-mode", baseRevision: 1, value: true,
    }), { status: 422, code: "INVALID_SLOT" });

    key = { protocolVersion, stepAttemptId: activity.stepAttemptId, operationId: "confirm" };
    const revisions = [original.revision, empty.revision, 0, wrong.revision];
    const input = { ...key, slotId: "answers", questions: questions.map((question, index) => {
      const revision = revisions[index];
      assert.ok(revision !== undefined);
      return { questionId: question.id, questionVersion: question.version, revision, original: { state: "uncollected" as const } };
    }) };
    assert.throws(() => runtime.confirmResponses(student, activity.activityId, input), { status: 422, code: "INVALID_SLOT" });
    const stale = { ...input, questions: input.questions.map(item => item.questionId === original.questionId ? { ...item, revision: 0 } : item) };
    assert.throws(() => runtime.confirmIndexResponses(student, activity.activityId, stale), error => {
      assert.ok(error instanceof IndexResponseDraftConflict && error.questionId === original.questionId);
      assert.deepEqual(error.current, { revision: 1, value: [2, 0, 2] });
      return true;
    });
    assert.deepEqual(rowCounts(databasePath), [0, 0, 0, 0, 0]);
    {
      using fault = new DatabaseSync(databasePath);
      fault.exec(`CREATE TRIGGER fail_index_task BEFORE INSERT ON evaluation_tasks BEGIN
        SELECT RAISE(ABORT, 'index task unavailable');
      END`);
      assert.throws(() => runtime.confirmIndexResponses(student, activity.activityId, input), /index task unavailable/);
      assert.deepEqual(rowCounts(databasePath), [0, 0, 0, 0, 0]);
      assert.deepEqual(runtime.read(student, activity.activityId), current);
      fault.exec("DROP TRIGGER fail_index_task");
    }
    receipt = runtime.confirmIndexResponses(student, activity.activityId, input);
    assert.deepEqual(runtime.confirmIndexResponses(student, activity.activityId, input), receipt);
    const done = runtime.read(student, activity.activityId);
    assert.ok("formatVersion" in done && done.submission?.indexResponseConfirmation);
    assert.equal(done.submission.responseConfirmation, undefined);
    assert.deepEqual(done.submission.indexResponseConfirmation.questions.map(question => question.value), [[2, 0, 2], [], null, [0]]);
    assert.doesNotMatch(JSON.stringify(done), /acceptedIndexes|acceptedResponses|scoringKey/);
    assert.deepEqual(rowCounts(databasePath), [1, 1, 1, 2, 0]);
    failedEvaluation = true;
    assert.throws(() => runtime.recoverIndexResponseConfirmation(student, activity.activityId, key), /评价暂不可用/);
    assert.deepEqual(rowCounts(databasePath), [1, 1, 1, 2, 0]);
    runtime.publish(publication(2, [1, 2]));
  } finally { runtime.close(); }

  failedEvaluation = false;
  const reopened = openLearningRuntime(settings);
  try {
    assert.deepEqual(reopened.start(student, opening()), activity);
    assert.throws(() => reopened.recoverIndexResponseConfirmation(outsider, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    permitted = false;
    assert.throws(() => reopened.recoverIndexResponseConfirmation(student, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    permitted = true;
    assert.throws(() => reopened.recoverResponseConfirmation(student, activity.activityId, key), { status: 404, code: "CONFIRMATION_NOT_FOUND" });
    const reviewer = { role: "reviewer", id: "reviewer" } as const;
    assert.throws(() => reopened.readQuestionDeliveryReview(reviewer, activity.activityId, key, "responseConfirmation"),
      { status: 404, code: "REVIEW_NOT_FOUND" });
    assert.throws(() => reopened.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, {
      protocolVersion, submissionId: receipt.id, targetId: "answer", questionId: "selected",
      expectedRevision: 0, action: "override", correct: false, operationId: "mark-index", reason: "复核",
    }, "responseConfirmation"), { status: 403, code: "FORBIDDEN" });
    const proof = reopened.recoverIndexResponseConfirmation(student, activity.activityId, key);
    assert.deepEqual(proof.receipt, receipt);
    assert.deepEqual(proof.confirmation.questions.map(question => question.value), [[2, 0, 2], [], null, [0]]);
    assert.deepEqual(proof.responseDraftChangeCounts.map(item => item.changeCount), [1, 1, 0, 1]);
    assert.deepEqual(proof.evaluation.questions.map(question => question.result),
      [true, false, false, false].map(correct => ({ status: "judged", correct })));
    assert.deepEqual(observed, [
      { value: [2, 0, 2], acceptedIndexes: [0, 2] }, { value: [], acceptedIndexes: [0] },
      { value: null, acceptedIndexes: [1] }, { value: [0], acceptedIndexes: [1, 2] },
    ]);
    assert.deepEqual(reopened.recoverIndexResponseConfirmation(student, activity.activityId, key), proof);
    assert.equal(observed.length, 4);
    assert.deepEqual(rowCounts(databasePath), [1, 1, 1, 2, 4]);
    assert.doesNotMatch(JSON.stringify(proof), /acceptedIndexes|acceptedResponses|scoringKey/);
  } finally { reopened.close(); }
});
