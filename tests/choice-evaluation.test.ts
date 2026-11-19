import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { startActivity } from "../src/kernel/activity.ts";
import { evaluatePending } from "../src/kernel/evaluation.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { saveDraft, submitDraft } from "../src/kernel/submission.ts";
import { openLearningRuntime } from "../src/server.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ChoiceEvaluator, PublicationInput } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const evaluator = { id: "host-choice", version: 1 };
const student = { role: "student", id: "student" } as const;
const other = { role: "student", id: "other" } as const;
const open = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;
const confirmation = { protocolVersion: 1, operationId: "confirm" } as const;
const { practice, scoringKey } = frozenChoicePublication;
const [step] = practice.steps;
const registeredPublication = {
  scoringKey,
  practice: {
    ...practice,
    questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })),
    steps: [{ ...step, submit: { ...step.submit, slots: {
      answers: { ...step.submit.slots.answers, confirmFromDrafts: { allowUnanswered: true } },
    } } }],
    grading: { assessment: { ...practice.grading.assessment, evaluator } },
    policy: { ...practice.policy, student: {
      ownSubmission: { ...practice.policy.student.ownSubmission, fields: ["receipt"], onFinal: ["passageGradingStatus"] },
      passageScore: {
        whenAll: ["finalConfirmed", "allQuestionsJudged"], group: "wholePassage",
        fields: ["correctCount", "questionCount"], allowSubsets: false, drilldown: false,
      },
    } },
  },
} satisfies PublicationInput;

function rejectsPublication(error: unknown) {
  return error instanceof ZodError && error.issues.some(issue => issue.path.join(".") === "practice.grading.assessment.evaluator");
}

function evaluationFacts(database: DatabaseSync, submissionId: string) {
  const task = database.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(submissionId);
  const verdicts = database.prepare("SELECT question_id, correct FROM automatic_verdicts WHERE submission_id = ? ORDER BY question_id")
    .all(submissionId).map(row => [row.question_id, row.correct]);
  return { status: task?.status, verdicts };
}

test("发布仅接受整卷配置中的精确宿主评估器，保留历史内置能力名称", t => {
  const path = scenarioDatabase(t);
  const evaluate = () => true;
  const registration = { ...evaluator, evaluate };
  for (const invalid of [[registration, registration], [{ ...registration, id: "choice-key", version: 2 }],
    [{ ...registration, id: "single-choice-group" }]]) {
    assert.throws(() => openLearningRuntime({ databasePath: path, choiceEvaluators: invalid }), { name: "ZodError" });
  }
  const missing = openLearningRuntime({ databasePath: path });
  try {
    assert.throws(() => missing.publish(registeredPublication), rejectsPublication);
  } finally {
    missing.close();
  }
  assert.doesNotThrow(() => {
    const runtime = openLearningRuntime({ databasePath: path, choiceEvaluators: [registration, { ...registration, version: 2 }] });
    try {
      for (const unavailable of [{ ...evaluator, version: 3 }, { ...evaluator, id: "unknown" }]) {
        assert.throws(() => runtime.publish({
          ...registeredPublication, practice: { ...registeredPublication.practice,
            grading: { assessment: { ...practice.grading.assessment, evaluator: unavailable } },
          },
        }), rejectsPublication);
      }
      assert.throws(() => runtime.publish({
        scoringKey, practice: { ...practice, grading: { assessment: { ...practice.grading.assessment, evaluator } } },
      }), rejectsPublication);
      using database = new DatabaseSync(path);
      for (const table of ["practices", "scoring_keys"]) {
        assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0);
      }
      runtime.publish(registeredPublication);
    } finally {
      runtime.close();
    }
  });
});

test("已确认评估在当前权限下恢复，坏回调和第二题写入失败都保留待评任务", t => {
  const path = scenarioDatabase(t);
  let canRecover = false;
  let callbackCalls = 0;
  let fail = true;
  const authorizeConfirmationRecovery: AuthorizeConfirmationRecovery = scope =>
    canRecover && scope.studentId === student.id && scope.operationId === confirmation.operationId;
  const evaluate: ChoiceEvaluator = input => {
    callbackCalls++;
    if (fail && callbackCalls === 2) throw new Error("evaluator interrupted");
    return input.choice !== null;
  };
  const runtime = openLearningRuntime({
    databasePath: path, authorizeConfirmationRecovery, choiceEvaluators: [{ ...evaluator, evaluate }],
  });
  try {
    runtime.publish(registeredPublication);
    using database = new DatabaseSync(path);
    const { activityId, stepAttemptId } = startActivity(database, student.id, open, () => new Date(), "teacher");
    const key = { ...confirmation, stepAttemptId };
    const input: ChoiceConfirmationInput = { ...key, slotId: "answers", questions: registeredPublication.practice.questions.map(question => {
      assert.ok(question.version);
      return { questionId: question.id, questionVersion: question.version, revision: 0, original: { state: "uncollected" } };
    }) };
    const receipt = runtime.confirmChoices(student, activityId, input);
    const pending = { status: "pending", verdicts: [] };
    assert.deepEqual(evaluationFacts(database, receipt.id), pending);
    const view = runtime.read(student, activityId);
    assert.ok("formatVersion" in view);
    assert.deepEqual(view.assessment, { status: "pending" });
    assert.deepEqual(view.submission, { receipt });
    assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, key), { status: 403, code: "FORBIDDEN" });
    canRecover = true;
    assert.throws(() => runtime.recoverChoiceConfirmation(other, activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.equal(callbackCalls, 0);

    const legacyReceipt = confirmLegacy(runtime, database);
    assert.doesNotThrow(() => evaluatePending(database));
    assert.deepEqual(evaluationFacts(database, receipt.id), pending);
    assert.deepEqual(evaluationFacts(database, legacyReceipt.id), {
      status: "done", verdicts: questions.map(question => [question.id, 1]),
    });
    assert.equal(callbackCalls, 0);

    assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, key), /evaluator interrupted/);
    assert.equal(callbackCalls, 2);
    assert.deepEqual(evaluationFacts(database, receipt.id), pending);
    const baseOptions = { databasePath: path, authorizeConfirmationRecovery };
    const noEvaluator = openLearningRuntime(baseOptions);
    try {
      assert.throws(() => noEvaluator.recoverChoiceConfirmation(student, activityId, key), { status: 503, code: "EVALUATOR_UNAVAILABLE" });
      assert.deepEqual(evaluationFacts(database, receipt.id), pending);
    } finally {
      noEvaluator.close();
    }
    const invalid: ReturnType<typeof openLearningRuntime> = Reflect.apply(openLearningRuntime, undefined, [{
      ...baseOptions, choiceEvaluators: [{ ...evaluator, evaluate: () => Promise.resolve(true) }],
    }]);
    try {
      assert.throws(() => invalid.recoverChoiceConfirmation(student, activityId, key), { name: "ZodError" });
      assert.deepEqual(evaluationFacts(database, receipt.id), pending);
    } finally {
      invalid.close();
    }

    fail = false;
    database.exec(`CREATE TRIGGER reject_second_verdict BEFORE INSERT ON automatic_verdicts
      WHEN EXISTS (SELECT 1 FROM automatic_verdicts WHERE submission_id = NEW.submission_id)
      BEGIN SELECT RAISE(ABORT, 'second verdict unavailable'); END`);
    assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, key), /second verdict unavailable/);
    assert.equal(callbackCalls, 4);
    assert.deepEqual(evaluationFacts(database, receipt.id), pending);
    database.exec("DROP TRIGGER reject_second_verdict");

    const recovered = runtime.recoverChoiceConfirmation(student, activityId, key);
    assert.deepEqual(recovered.evaluation, { evaluator, questionCount: 2, correctCount: 0,
      questions: input.questions.map(({ questionId, questionVersion }) => ({ questionId, questionVersion, correct: false })),
    });
    assert.deepEqual(evaluationFacts(database, receipt.id), {
      status: "done", verdicts: input.questions.map(question => [question.questionId, 0]),
    });
    const withoutCallback = openLearningRuntime(baseOptions);
    try {
      assert.deepEqual(withoutCallback.recoverChoiceConfirmation(student, activityId, key), recovered);
      const completed = withoutCallback.read(student, activityId);
      assert.ok("formatVersion" in completed);
      assert.deepEqual(completed.assessment, { status: "complete", correctCount: 0, questionCount: 2 });
      assert.doesNotMatch(JSON.stringify(completed), /acceptedChoices|scoringKey|"correct"/);
    } finally {
      withoutCallback.close();
    }
    assert.equal(callbackCalls, 6);
    assert.deepEqual(manageReading(database, "teacher", activityId, "revokeStudent"), { studentActive: false });
    assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => runtime.confirmChoices(student, activityId, input), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => runtime.read(student, activityId), { status: 403, code: "FORBIDDEN" });
    assert.equal(callbackCalls, 6);
  } finally {
    runtime.close();
  }
});

function confirmLegacy(runtime: ReturnType<typeof openLearningRuntime>, database: DatabaseSync) {
  const legacy = "old-choice-key";
  runtime.publish({ ...frozenChoicePublication, practice: { ...practice, id: legacy } });
  const { activityId, stepAttemptId } = runtime.start(student, { ...open, operationId: legacy, practiceId: legacy });
  const slot = { protocolVersion: 1, slotId: "answers", stepAttemptId } as const;
  const draft = saveDraft(database, student.id, activityId, { ...slot, choices: scoringKey.acceptedChoices, references: {} });
  return submitDraft(database, student.id, activityId, { ...slot, operationId: "confirm-legacy", draft: draft.draft }, () => new Date());
}
