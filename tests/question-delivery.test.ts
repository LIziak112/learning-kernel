import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { evaluatePending } from "../src/kernel/evaluation.ts";
import { readPersonalDraft } from "../src/kernel/work-versions.ts";
import { openLearningRuntime, QuestionDeliveryConflict } from "../src/server.ts";
import type {
  ChoiceConfirmationInput, ChoiceEvaluationInput, IndexResponseEvaluationInput, PublicationInput,
  OrderedTextEvaluationInput, QuestionDeliveryInput, ResponseEvaluationInput, TitledTextEvaluationInput, VerifyOriginal,
} from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "delivery-learner" } as const;
const outsider = { ...student, id: "other-learner" };
const evaluator = { id: "delivery-evaluator", version: 1 };
type ReadingPractice = Extract<PublicationInput, { practice: { formatVersion: 1 } }>["practice"];

const base = {
  version: 1, formatVersion: 1, title: "分组作答",
  goals: { answer: "交付作答" },
  policy: {
    offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
    student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownChoices"], onFinal: [] } },
    reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
    manager: { scope: "assigningTeacher", actions: [] },
  } satisfies ReadingPractice["policy"],
} as const;

function frozenQuestion(id: string, version: number) {
  return { id, version, prompt: "选择或输入答案。", options: { "0": "绿色", "1": "蓝色", "2": "白色" } };
}

const strictChoice = frozenQuestion("choice", 2);
const nextChoice = frozenQuestion("later", 3);
const judgeQuestion = frozenQuestion("judge", 4);
const pendingQuestion = frozenQuestion("unrecognized", 5);
const selectedIndexes = frozenQuestion("indexes", 6);
const emptyIndexes = frozenQuestion("empty", 7);
const noDraft = frozenQuestion("missing", 8);

const step = {
  id: "answer", instructions: "完成当前题。", inputs: { questions: { from: "questions" } },
  afterConfirmation: "finish",
} as const;
const slot = { source: "questions", targetId: "answer", confirmFromDrafts: { allowUnanswered: true } } as const;
const keyRef = { id: "delivery-key", version: 1 };
const grading = { assessment: {
  from: { stepId: "answer", slotId: "answers" }, evaluator, keyRef,
  unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
} } satisfies NonNullable<ReadingPractice["grading"]>;
const responsePolicy = {
  ...base.policy,
  student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
} satisfies ReadingPractice["policy"];

function choiceGroup(id: string) {
  return {
    practice: { ...base, id, questions: [strictChoice, nextChoice], grading,
      steps: [{ ...step, tool: { id: "single-choice-group", version: 1 },
        submit: { purpose: "finalAnswer", slots: { answers: { type: "oneChoicePerQuestion", ...slot } } },
      }],
    },
    scoringKey: { ...keyRef, acceptedChoices: { choice: "1", later: "2" } },
  } satisfies PublicationInput;
}

function responseGroup(id: string, input: "booleanOrString" | "optionIndexArray") {
  const scalar = input === "booleanOrString";
  const responseKeyRef = { ...keyRef, id: `${id}-key` };
  return {
    practice: { ...base, id, questions: scalar ? [judgeQuestion, pendingQuestion] : [selectedIndexes, emptyIndexes, noDraft],
      policy: responsePolicy, grading: { assessment: { ...grading.assessment, keyRef: responseKeyRef } },
      steps: [{ ...step, tool: { id: "response-group", version: 1 },
        submit: { purpose: "finalAnswer", slots: { answers: { type: "oneResponsePerQuestion", input, ...slot } } },
      }],
    },
    scoringKey: scalar
      ? { ...responseKeyRef, acceptedResponses: { judge: true, unrecognized: false } }
      : { ...responseKeyRef, acceptedIndexes: { indexes: [0, 2], empty: [1], missing: [2] } },
  } satisfies PublicationInput;
}

type EvaluationInput = ChoiceEvaluationInput | ResponseEvaluationInput | IndexResponseEvaluationInput;
function settings(databasePath: string, canRecover = () => true, observe?: (input: EvaluationInput) => void) {
  return { databasePath, authorizeConfirmationRecovery: () => canRecover(),
    choiceEvaluators: [{ ...evaluator, evaluate: (input: ChoiceEvaluationInput) => {
      observe?.(input);
      return input.choice === input.acceptedChoice;
    } }],
    responseEvaluators: [{ ...evaluator, evaluate: (input: ResponseEvaluationInput) => {
      observe?.(input);
      return typeof input.value === "string" ? { status: "needsReview" as const } :
        { status: "judged" as const, correct: input.value === input.acceptedResponse };
    } }],
    indexResponseEvaluators: [{ ...evaluator, evaluate: (input: IndexResponseEvaluationInput) => {
      observe?.(input);
      const { value, acceptedIndexes } = input;
      return { status: "judged" as const, correct: value !== null && new Set(value).size === new Set(acceptedIndexes).size &&
        acceptedIndexes.every(index => value.includes(index)) };
    } }],
  };
}

type Runtime = ReturnType<typeof openLearningRuntime>;
type Activity = ReturnType<Runtime["start"]>;

function open(runtime: Runtime, practiceId: string, operationId = practiceId) {
  return runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId });
}

function target(activity: Activity, question: { id: string; version: number }) {
  return { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId: "answers",
    questionId: question.id, questionVersion: question.version, operationId: `save-${question.id}`, baseRevision: 0 } as const;
}

function revision(question: { id: string; version: number }, revision: number) {
  return { questionId: question.id, questionVersion: question.version, revision, original: { state: "uncollected" as const } };
}

function intent(activity: Activity, questions: ChoiceConfirmationInput["questions"], operationId = "confirm") {
  return { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId: "answers", operationId, questions } as const;
}

function recoveryKey({ protocolVersion, stepAttemptId, operationId }: ChoiceConfirmationInput) {
  return { protocolVersion, stepAttemptId, operationId };
}

function deliveredView(runtime: Runtime, activity: Activity) {
  const view = runtime.read(student, activity.activityId);
  assert.ok("questionDeliveries" in view);
  return view;
}

function counts(databasePath: string) {
  using db = new DatabaseSync(databasePath, { readOnly: true });
  return Object.fromEntries(["practices", "scoring_keys", "activities", "submissions", "completions", "evaluation_tasks", "performances"]
    .map(table => [table, db.prepare("SELECT count(*) AS n FROM " + table).get()?.n]));
}

test("K16 公开入口的纯单选、纯标量和纯索引数组均能各自确认和取回评分", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(settings(databasePath));
  try {
    runtime.publish(choiceGroup("pure-choice"));
    runtime.publish(responseGroup("pure-scalar", "booleanOrString"));
    runtime.publish(responseGroup("pure-indexes", "optionIndexArray"));

    const single = open(runtime, "pure-choice");
    const selected = runtime.saveChoiceDraft(student, single.activityId, { ...target(single, strictChoice), choice: "1" });
    const singleInput = intent(single, [revision(strictChoice, selected.revision), revision(nextChoice, 0)]);
    const singleReceipt = runtime.confirmChoices(student, single.activityId, singleInput);
    const singleResult = runtime.recoverChoiceConfirmation(student, single.activityId, recoveryKey(singleInput));
    assert.deepEqual(singleResult.receipt, singleReceipt);
    assert.deepEqual(singleResult.confirmation.questions.map(item => item.choice), ["1", null]);

    const scalar = open(runtime, "pure-scalar");
    const understood = runtime.saveResponseDraft(student, scalar.activityId, { ...target(scalar, judgeQuestion), value: true });
    const unknown = runtime.saveResponseDraft(student, scalar.activityId, { ...target(scalar, pendingQuestion), value: "  原话  " });
    const scalarInput = intent(scalar, [revision(judgeQuestion, understood.revision), revision(pendingQuestion, unknown.revision)]);
    const scalarReceipt = runtime.confirmResponses(student, scalar.activityId, scalarInput);
    const scalarResult = runtime.recoverResponseConfirmation(student, scalar.activityId, recoveryKey(scalarInput));
    assert.deepEqual(scalarResult.receipt, scalarReceipt);
    assert.deepEqual(scalarResult.confirmation.questions.map(item => item.value), [true, "  原话  "]);
    assert.deepEqual(scalarResult.evaluation.questions, [
      { questionId: "judge", questionVersion: 4, result: { status: "judged", correct: true } },
      { questionId: "unrecognized", questionVersion: 5, result: { status: "needsReview" } },
    ]);

    const multi = open(runtime, "pure-indexes");
    const chosen = runtime.saveIndexResponseDraft(student, multi.activityId, { ...target(multi, selectedIndexes), value: [2, 0, 2] });
    const blank = runtime.saveIndexResponseDraft(student, multi.activityId, { ...target(multi, emptyIndexes), value: [] });
    const multiInput = intent(multi, [revision(selectedIndexes, chosen.revision), revision(emptyIndexes, blank.revision), revision(noDraft, 0)]);
    const multiReceipt = runtime.confirmIndexResponses(student, multi.activityId, multiInput);
    const multiResult = runtime.recoverIndexResponseConfirmation(student, multi.activityId, recoveryKey(multiInput));
    assert.deepEqual(multiResult.receipt, multiReceipt);
    assert.deepEqual(multiResult.confirmation.questions.map(item => item.value), [[2, 0, 2], [], null]);
    assert.equal(runtime.read(student, multi.activityId).status, "completed");
    assert.doesNotMatch(JSON.stringify(runtime.read(student, multi.activityId)), /acceptedChoices|acceptedResponses|acceptedIndexes/);
    assert.deepEqual(counts(databasePath), {
      practices: 3, scoring_keys: 3, activities: 3, submissions: 3, completions: 3, evaluation_tasks: 3, performances: 4,
    });
  } finally { runtime.close(); }
});

function mixedGroup(version = 1) {
  const key = { ...keyRef, version };
  return {
    practice: { ...base, id: "mixed-delivery", version, policy: responsePolicy,
      grading: { assessment: { ...grading.assessment, keyRef: key } },
      questions: [
        { ...strictChoice, response: "choice" },
        { ...judgeQuestion, response: "booleanOrString" },
        { ...pendingQuestion, response: "booleanOrString" },
        ...[selectedIndexes, emptyIndexes, noDraft].map(question => ({ ...question, response: "optionIndexArray" as const })),
      ],
      steps: [{ ...step, tool: { id: "question-delivery", version: 1 },
        submit: { purpose: "finalAnswer", slots: { answers: { type: "questionDelivery", delivery: { mode: "whole" }, ...slot } } },
      }],
    },
    scoringKey: { ...key, acceptedByQuestion: {
      choice: { response: "choice", acceptedChoice: version === 1 ? "1" : "2" },
      judge: { response: "booleanOrString", acceptedResponse: version === 1 },
      unrecognized: { response: "booleanOrString", acceptedResponse: false },
      indexes: { response: "optionIndexArray", acceptedIndexes: version === 1 ? [0, 2] : [1] },
      empty: { response: "optionIndexArray", acceptedIndexes: [1] },
      missing: { response: "optionIndexArray", acceptedIndexes: [2] },
    } },
  } satisfies PublicationInput;
}

test("A 同组混合作答原子确认，按冻结私钥评估并重开取回同一结果", t => {
  const databasePath = scenarioDatabase(t);
  const observed: EvaluationInput[] = [];
  let failEvaluation = true;
  let authorized = true;
  const options = settings(databasePath, () => authorized, input => {
    if (failEvaluation && input.questionId === "indexes") throw new Error("评分暂时失败");
    observed.push(input);
  });
  const runtime = openLearningRuntime(options);
  let activity: Activity;
  let input: QuestionDeliveryInput;
  let receipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  try {
    runtime.publish(mixedGroup());
    activity = open(runtime, "mixed-delivery");
    const values = [
      [strictChoice, "1"], [judgeQuestion, true], [pendingQuestion, "  原话  "], [selectedIndexes, [2, 0, 2]], [emptyIndexes, []],
    ] satisfies [typeof strictChoice, string | boolean | number[]][];
    const drafts = values.map(([question, value]) => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, question), value }));
    const save = { ...target(activity, selectedIndexes), value: [2, 0, 2] };
    assert.deepEqual(runtime.saveQuestionDeliveryDraft(student, activity.activityId, save), drafts[3]);
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, value: [0, 2, 2] }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, operationId: "invalid", value: [3] }),
      { status: 422, code: "INVALID_OPTION_INDEX" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, operationId: "wrong-mode", value: true }),
      { status: 422, code: "INVALID_OPTION_INDEX" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, operationId: "text-array", value: ["0"] }),
      { status: 422, code: "INVALID_OPTION_INDEX" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, questionVersion: 1 }),
      { status: 409, code: "QUESTION_REVISION_STALE" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, strictChoice), value: "3" }),
      { status: 422, code: "INVALID_CHOICE" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, judgeQuestion), value: [0] }),
      { status: 422, code: "INVALID_RESPONSE" });
    assert.throws(() => runtime.saveChoiceDraft(student, activity.activityId, { ...target(activity, strictChoice), choice: "1" }), { code: "INVALID_SLOT" });
    const active = deliveredView(runtime, activity);
    assert.equal(active.status, "active");
    assert.equal(active.questionDeliveryDrafts.length, 5);
    assert.doesNotMatch(JSON.stringify(active), /acceptedByQuestion|acceptedChoice|acceptedResponse|acceptedIndexes|requestQuestions/);
    input = { ...intent(activity, drafts.map(({ questionId, questionVersion, revision }) => ({
      questionId, questionVersion, revision, original: { state: "uncollected" as const },
    })).concat(revision(noDraft, 0))), source: "whole" };
    using direct = new DatabaseSync(databasePath);
    direct.exec(`CREATE TRIGGER reject_task BEFORE INSERT ON evaluation_tasks BEGIN SELECT RAISE(ABORT, 'task write failed'); END;`);
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, input), /task write failed/);
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
    assert.equal(direct.prepare("SELECT count(*) AS count FROM works").get()?.count, 5);
    assert.deepEqual(deliveredView(runtime, activity), active);
    direct.exec("DROP TRIGGER reject_task");

    receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
    evaluatePending(direct);
    assert.equal(direct.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(receipt.id)?.status, "pending");
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, { ...input, questions: input.questions.toReversed() }), receipt);
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, { ...input, source: "finish" }),
      { status: 409, code: "OPERATION_CONFLICT" });
    runtime.publish(mixedGroup(2));
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input)), /评分暂时失败/);
    const formalWork = direct.prepare("SELECT work_id FROM submissions WHERE id = ?").get(receipt.id)?.work_id;
    assert.ok(typeof formalWork === "string");
    assert.throws(() => readPersonalDraft(direct, student.id, formalWork), { status: 403, code: "FORBIDDEN" });
    assert.equal(direct.prepare("SELECT count(*) AS count FROM automatic_verdicts").get()?.count, 0);
    assert.equal(direct.prepare("SELECT count(*) AS count FROM response_review_requirements").get()?.count, 0);
  } finally { runtime.close(); }

  failEvaluation = false;
  observed.length = 0;
  const reopened = openLearningRuntime(options);
  try {
    assert.deepEqual(open(reopened, "mixed-delivery"), activity);
    const key = recoveryKey(input);
    const recovered = reopened.recoverQuestionDelivery(student, activity.activityId, key);
    assert.deepEqual(recovered.receipt, receipt);
    assert.deepEqual(recovered.practice, { id: "mixed-delivery", version: 1 });
    assert.deepEqual(recovered.confirmation.questions.map(question => [question.questionId, question.revision, question.value]), [
      ["choice", 1, "1"], ["judge", 1, true], ["unrecognized", 1, "  原话  "], ["indexes", 1, [2, 0, 2]], ["empty", 1, []], ["missing", 0, null],
    ]);
    assert.deepEqual(recovered.evaluation.questions.map(({ result }) => result), [
      { status: "judged", correct: true }, { status: "judged", correct: true }, { status: "needsReview" }, { status: "judged", correct: true },
      { status: "judged", correct: false }, { status: "judged", correct: false },
    ]);
    assert.deepEqual(observed.map(evidence => [
      evidence.questionId, evidence.questionVersion,
      "acceptedChoice" in evidence ? evidence.acceptedChoice :
        "acceptedResponse" in evidence ? evidence.acceptedResponse : evidence.acceptedIndexes,
    ]), [["choice", 2, "1"], ["judge", 4, true], ["unrecognized", 5, false], ["indexes", 6, [0, 2]], ["empty", 7, [1]], ["missing", 8, [2]]]);
    assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, key), recovered);
    assert.equal(observed.length, 6);
    const finished = deliveredView(reopened, activity);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.questionDeliveries, [{ receipt, questionDelivery: recovered.confirmation }]);
    assert.deepEqual(finished.questionDeliveryDrafts, []);
    assert.doesNotMatch(JSON.stringify(finished), /acceptedByQuestion|acceptedChoice|acceptedResponse|acceptedIndexes|requestQuestions|needsReview/);
    assert.throws(() => reopened.recoverQuestionDelivery(outsider, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    authorized = false;
    assert.throws(() => reopened.recoverQuestionDelivery(student, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => reopened.confirmQuestionDelivery(student, activity.activityId, input), { status: 403, code: "FORBIDDEN" });
    assert.deepEqual(counts(databasePath), {
      practices: 2, scoring_keys: 2, activities: 1, submissions: 1, completions: 1, evaluation_tasks: 1, performances: 4,
    });
  } finally { reopened.close(); }
});

const activeBlank = frozenQuestion("blank", 6);
const unattended = frozenQuestion("unattended", 7);

function sequentialGroup(id: string, questions = [strictChoice, activeBlank, nextChoice, unattended], allowUnanswered = true) {
  return {
    practice: { ...base, id, questions: questions.map(question => ({ ...question, response: "choice" as const })), grading,
      policy: structuredClone(responsePolicy),
      steps: [{ ...step, tool: { id: "question-delivery", version: 1 },
        submit: { purpose: "finalAnswer", slots: { answers: {
          type: "questionDelivery", ...slot, confirmFromDrafts: { allowUnanswered },
          delivery: { mode: "perQuestion", questionSlots: Object.fromEntries(questions.map(({ id }) => [id, `position-${id}`])) },
        } } },
      }],
    },
    scoringKey: { ...keyRef, acceptedByQuestion: Object.fromEntries(questions.map(({ id }) =>
      [id, { response: "choice" as const, acceptedChoice: "1" }])) },
  } satisfies PublicationInput;
}

function byQuestion(activity: Activity, question: ChoiceConfirmationInput["questions"][number], operationId: string) {
  return { ...intent(activity, [question], operationId), source: "question", questions: [question] } satisfies QuestionDeliveryInput;
}

test("B 同一活动逐题交、主动空交、关机复读，早收余稿和被动未答一次", t => {
  const databasePath = scenarioDatabase(t);
  let authorized = true;
  const evaluated: string[] = [];
  const verified: string[] = [];
  const options = { ...settings(databasePath, () => authorized, ({ questionId }) => evaluated.push(questionId)),
    verifyOriginal: (({ questionId, original }) => {
      verified.push(questionId);
      return original.state !== "frozen" || original.versionId === "paper-v1";
    }) satisfies VerifyOriginal,
  };
  const runtime = openLearningRuntime(options);
  let activity: Activity;
  let firstInput: QuestionDeliveryInput;
  let blankInput: QuestionDeliveryInput;
  let firstReceipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  let blankReceipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  let beforeClose: ReturnType<typeof deliveredView>;
  try {
    runtime.publish(sequentialGroup("per-question"));
    activity = open(runtime, "per-question");
    const first = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, strictChoice), value: "1" });
    const laterDraft = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, nextChoice), value: "2" });
    firstInput = byQuestion(activity, { ...revision(strictChoice, first.revision), original: {
      state: "frozen", documentId: "paper", versionId: "paper-v1", sha256: "ad".repeat(32),
    } }, "first-only");
    firstReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, firstInput);
    assert.equal(firstReceipt.slotId, "position-choice");
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, firstInput), firstReceipt);
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, { ...firstInput, operationId: "competing-first" }),
      { status: 409, code: "ALREADY_SUBMITTED" });
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, { ...recoveryKey(firstInput), operationId: "not-submitted" }),
      { status: 404, code: "CONFIRMATION_NOT_FOUND" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, strictChoice), value: "2" }),
      { status: 409, code: "ALREADY_SUBMITTED" });
    assert.throws(() => runtime.saveChoiceDraft(student, activity.activityId, {
      ...target(activity, strictChoice), slotId: firstReceipt.slotId, choice: "1",
    }), { status: 422, code: "INVALID_SLOT" });
    const interim = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(firstInput));
    assert.equal(interim.confirmation.source, "question");
    assert.deepEqual(interim.confirmation.questions, [{ ...firstInput.questions[0], value: "1" }]);
    assert.deepEqual(interim.evaluation.questions.map(question => question.questionId), ["choice"]);
    assert.equal(deliveredView(runtime, activity).status, "active");
    assert.deepEqual(deliveredView(runtime, activity).questionDeliveryDrafts, [laterDraft]);
    assert.deepEqual(deliveredView(runtime, activity).questionDeliveries, [{ receipt: firstReceipt, questionDelivery: interim.confirmation }]);

    blankInput = byQuestion(activity, revision(activeBlank, 0), "blank-only");
    blankReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, blankInput);
    const blank = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(blankInput));
    assert.deepEqual(blank.receipt, blankReceipt);
    assert.equal(blank.confirmation.source, "question");
    assert.deepEqual(blank.confirmation.questions, [{ ...blankInput.questions[0], value: null }]);
    assert.deepEqual(blank.evaluation.questions, [{
      questionId: "blank", questionVersion: 6, result: { status: "judged", correct: false },
    }]);
    beforeClose = deliveredView(runtime, activity);
    assert.equal(beforeClose.status, "active");
    assert.deepEqual(beforeClose.questionDeliveryDrafts, [laterDraft]);
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 2, completions: 0, evaluation_tasks: 2, performances: 1,
    });
  } finally { runtime.close(); }

  const reopened = openLearningRuntime(options);
  let finish: Extract<QuestionDeliveryInput, { source: "finish" }>;
  let endReceipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  try {
    assert.deepEqual(open(reopened, "per-question"), activity);
    assert.deepEqual(deliveredView(reopened, activity), beforeClose);
    const again = reopened.recoverQuestionDelivery(student, activity.activityId, recoveryKey(firstInput));
    assert.deepEqual(again.receipt, firstReceipt);
    assert.deepEqual(evaluated, ["choice", "blank"]);
    const later = reopened.saveQuestionDeliveryDraft(student, activity.activityId, {
      ...target(activity, nextChoice), operationId: "revise-later", baseRevision: 1, value: "0",
    });
    finish = {
      ...intent(activity, [revision(strictChoice, 0), revision(activeBlank, 0), revision(nextChoice, later.revision), revision(unattended, 0)],
        "finish-remaining"), source: "finish",
    };
    const stale = { ...finish, questions: finish.questions.map(question => question.questionId === "later" ? revision(nextChoice, 1) : question) };
    assert.throws(() => reopened.confirmQuestionDelivery(student, activity.activityId, stale), error =>
      error instanceof QuestionDeliveryConflict && error.questionId === "later" && error.current.revision === 2 && error.current.value === "0");
    assert.throws(() => reopened.confirmQuestionDelivery(student, activity.activityId, {
      ...finish, questions: finish.questions.map(question => question.questionId === "choice" ? { ...question, questionVersion: 1 } : question),
    }), { status: 409, code: "QUESTION_REVISION_STALE" });
    assert.deepEqual(deliveredView(reopened, activity).questionDeliveryDrafts, [later]);

    endReceipt = reopened.confirmQuestionDelivery(student, activity.activityId, finish);
    assert.equal(endReceipt.slotId, "answers");
    const completed = reopened.recoverQuestionDelivery(student, activity.activityId, recoveryKey(finish));
    assert.deepEqual(completed.receipt, endReceipt);
    assert.deepEqual(completed.requestQuestions, finish.questions);
    assert.equal(completed.confirmation.source, "finish");
    assert.deepEqual(completed.confirmation.questions, [
      { ...revision(nextChoice, 2), value: "0" }, { ...revision(unattended, 0), value: null },
    ]);
    assert.deepEqual(completed.draftChangeCounts, [
      { questionId: "later", changeCount: 2 }, { questionId: "unattended", changeCount: 0 },
    ]);
    assert.deepEqual(evaluated, ["choice", "blank", "later", "unattended"]);
    assert.deepEqual(verified, ["choice", "blank", "later", "unattended"]);
    assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, recoveryKey(firstInput)), again);
    assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, recoveryKey(blankInput)).receipt, blankReceipt);
    assert.deepEqual(deliveredView(reopened, activity).questionDeliveries.find(item => item.receipt?.id === endReceipt.id)?.questionDelivery,
      completed.confirmation);
    assert.equal(deliveredView(reopened, activity).status, "completed");
    assert.doesNotMatch(JSON.stringify(deliveredView(reopened, activity)), /acceptedByQuestion|requestQuestions/);
    assert.throws(() => reopened.confirmQuestionDelivery(student, activity.activityId, { ...finish, operationId: "another-finish" }),
      { status: 409, code: "ALREADY_SUBMITTED" });
  } finally { reopened.close(); }

  const final = openLearningRuntime(options);
  try {
    assert.deepEqual(final.confirmQuestionDelivery(student, activity.activityId, { ...finish, questions: finish.questions.toReversed() }), endReceipt);
    assert.throws(() => final.confirmQuestionDelivery(student, activity.activityId, {
      ...finish, questions: finish.questions.map(question => question.questionId === "choice" ? { ...question, revision: 1 } : question),
    }), { status: 409, code: "OPERATION_CONFLICT" });
    assert.throws(() => final.recoverQuestionDelivery(outsider, activity.activityId, recoveryKey(firstInput)), { status: 403, code: "FORBIDDEN" });
    authorized = false;
    assert.throws(() => final.recoverQuestionDelivery(student, activity.activityId, recoveryKey(finish)), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => final.confirmQuestionDelivery(student, activity.activityId, finish), { status: 403, code: "FORBIDDEN" });
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 3, completions: 1, evaluation_tasks: 3, performances: 2,
    });
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT submission_id FROM completions").get()?.submission_id, endReceipt.id);
  } finally { final.close(); }
});

test("逐题末次确认直接完成，未配置当前授权时两种回取入口都拒绝", t => {
  const databasePath = scenarioDatabase(t);
  const { choiceEvaluators } = settings(databasePath);
  const runtime = openLearningRuntime({ databasePath, choiceEvaluators });
  try {
    const publication = sequentialGroup("last-question", [strictChoice, nextChoice], false);
    publication.practice.policy.student.ownSubmission.fields = ["receipt"];
    runtime.publish(publication);
    const activity = open(runtime, "last-question");
    const empty = byQuestion(activity, revision(strictChoice, 0), "first");
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, empty), { status: 422, code: "UNANSWERED_QUESTION" });
    for (const question of [strictChoice, nextChoice]) {
      runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...target(activity, question), value: "1" });
    }
    const first = byQuestion(activity, revision(strictChoice, 1), "first");
    const firstReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, first);
    const active = deliveredView(runtime, activity);
    assert.equal(active.status, "active");
    assert.deepEqual(active.questionDeliveries, [{ receipt: firstReceipt }]);
    const last = byQuestion(activity, revision(nextChoice, 1), "last");
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, last);
    assert.equal(runtime.read(student, activity.activityId).status, "completed");
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, last), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(last)), { status: 403, code: "FORBIDDEN" });
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT submission_id FROM completions").get()?.submission_id, receipt.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM evaluation_tasks").get()?.n, 2);
  } finally { runtime.close(); }
});

test("发布校验拒绝逐题位置撞卷槽、缺少精确评估版本及私有键不匹配，失败不登记", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime({ ...settings(databasePath), indexResponseEvaluators: [] });
  try {
    const mixed = mixedGroup();
    const sequential = sequentialGroup("per-question");
    sequential.practice.steps[0].submit.slots.answers.delivery.questionSlots.choice = "answers";
    const pure = choiceGroup("unbound-format");
    const noDelivery = { ...pure, practice: {
      ...pure.practice, questions: [{ ...strictChoice, response: "choice" }, nextChoice],
    } };
    const candidates = [
      [mixed, "practice.grading.assessment.evaluator"],
      [noDelivery, "practice.questions.0.response"],
      [{ ...mixed, scoringKey: undefined }, "scoringKey"],
      [{ ...mixed, scoringKey: { ...mixed.scoringKey, version: 2 } }, "practice.grading.assessment.keyRef"],
      [{ ...mixed, practice: { ...mixed.practice, grading: {} } }, "practice.grading.assessment"],
      ...[{ stepId: "not-a-step", slotId: "answers" }, { stepId: "answer", slotId: "not-a-slot" }].map(from =>
        [{ ...mixed, practice: { ...mixed.practice, grading: { assessment: { ...mixed.practice.grading.assessment, from } } } },
          "practice.grading.assessment.from"] as const),
      [{ ...mixed, practice: { ...mixed.practice, questions: [] } }, "practice.steps"],
      [{ ...mixed, practice: { ...mixed.practice, questions: mixed.practice.questions.map(question =>
        question.id === "choice" ? { ...question, version: undefined, response: undefined } : question),
      } }, "practice.questions.0.version"],
      [sequential, "practice.steps.0.submit.slots.answers.delivery.questionSlots.choice"],
      [{ ...mixed, scoringKey: { ...mixed.scoringKey, acceptedByQuestion: {
        ...mixed.scoringKey.acceptedByQuestion, indexes: { response: "optionIndexArray", acceptedIndexes: [3] },
      } } }, "scoringKey.acceptedByQuestion.indexes"],
    ] as const;
    for (const [candidate, path] of candidates) {
      assert.throws(() => Reflect.apply(runtime.publish, runtime, [candidate]), error => error instanceof ZodError &&
        error.issues.some(issue => issue.path.join(".") === path));
      assert.throws(() => open(runtime, candidate.practice.id), { status: 404, code: "PRACTICE_NOT_FOUND" });
    }
    assert.deepEqual(counts(databasePath), {
      practices: 0, scoring_keys: 0, activities: 0, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
  } finally { runtime.close(); }
});

test("K16 纯单选把无稿题纳入全清单会确认空值并完成整卷", t => {
  const runtime = openLearningRuntime(settings(scenarioDatabase(t)));
  try {
    runtime.publish(choiceGroup("whole-with-empty"));
    const activity = open(runtime, "whole-with-empty");
    const first = runtime.saveChoiceDraft(student, activity.activityId, { ...target(activity, strictChoice), choice: "1" });
    const input = intent(activity, [revision(strictChoice, first.revision), revision(nextChoice, 0)]);
    const receipt = runtime.confirmChoices(student, activity.activityId, input);
    const result = runtime.recoverChoiceConfirmation(student, activity.activityId, recoveryKey(input));
    assert.deepEqual(result.receipt, receipt);
    assert.deepEqual(result.confirmation.questions.map(item => [item.questionId, item.revision, item.choice]), [
      ["choice", 1, "1"], ["later", 0, null],
    ]);
    assert.equal(runtime.read(student, activity.activityId).status, "completed");
  } finally { runtime.close(); }
});

const orderedTextQuestions = ["partial", "extra", "blank", "empty-array", "missing-text"].map(id => ({
  id, version: 9, prompt: "依次填写风向和云量。", response: "orderedTextBlanks" as const, blankCount: 2,
}));
const acceptedBlanks = [["西风", "偏西"], ["阴天"]];

function orderedTextGroup(version = 1, allowUnanswered = true) {
  const base = mixedGroup(version);
  const key = { response: "orderedTextBlanks" as const, acceptedBlanks: version === 1 ? acceptedBlanks : [["东风"], []] };
  return {
    practice: {
      ...base.practice, id: "ordered-text-delivery",
      questions: [{ ...strictChoice, response: "choice" }, ...orderedTextQuestions],
      steps: [{
        ...base.practice.steps[0],
        submit: { purpose: "finalAnswer", slots: { answers: {
          ...base.practice.steps[0].submit.slots.answers, confirmFromDrafts: { allowUnanswered },
        } } },
      }],
    },
    scoringKey: { ...base.scoringKey, acceptedByQuestion: {
      choice: base.scoringKey.acceptedByQuestion.choice,
      ...Object.fromEntries(orderedTextQuestions.map(({ id }) => [id, structuredClone(key)])),
    } },
  } satisfies PublicationInput;
}

function orderedTextSettings(databasePath: string, canRecover: () => boolean, observed: OrderedTextEvaluationInput[]) {
  return {
    ...settings(databasePath, canRecover),
    orderedTextEvaluators: [{ ...evaluator, evaluate: (input: OrderedTextEvaluationInput) => {
      observed.push(input);
      return input.questionId === "extra" ? { status: "judged", correct: false } as const : { status: "needsReview" } as const;
    } }],
  };
}

test("有序文本空位与客观题共用整卷确认，保存原值并以旧版私有键评估", t => {
  const databasePath = scenarioDatabase(t);
  const observed: OrderedTextEvaluationInput[] = [];
  let authorized = true;
  const config = orderedTextSettings(databasePath, () => authorized, observed);
  const runtime = openLearningRuntime(config);
  const published = orderedTextGroup();
  const initial = [
    ["choice", "1"], ["partial", ["  西风  "]], ["extra", ["", " 阴天 ", "附记"]],
    ["blank", ["", " \t\u3000"]], ["empty-array", []],
  ] satisfies [string, string | string[]][];
  let activity: Activity;
  let confirmation: QuestionDeliveryInput;
  let receipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  try {
    runtime.publish(published);
    activity = open(runtime, published.practice.id);
    const inputs = deliveredView(runtime, activity).inputs.questions;
    assert.equal(inputs?.from, "questions");
    const question = inputs.questions.find(({ id }) => id === "partial");
    assert.ok(question?.response === "orderedTextBlanks");
    assert.equal(question.blankCount, 2);
    assert.deepEqual(question.options, {});
    for (const [id, value] of initial) {
      const question = published.practice.questions.find(question => question.id === id);
      assert.ok(question);
      assert.equal(runtime.saveQuestionDeliveryDraft(student, activity.activityId,
        { ...target(activity, question), value }).revision, 1);
    }
    const before = deliveredView(runtime, activity);
    assert.equal(before.questionDeliveryDrafts.length, 5);
    assert.deepEqual(before.questionDeliveryDrafts.find(draft => draft.questionId === "partial")?.value, ["  西风  "]);
    const [partial] = orderedTextQuestions;
    assert.ok(partial);
    const save = { ...target(activity, partial), value: ["  西风  "] };
    assert.equal(runtime.saveQuestionDeliveryDraft(student, activity.activityId, save).revision, 1);
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, value: ["  西风  ", ""] }),
      { status: 409, code: "OPERATION_CONFLICT" });
    for (const value of ["西风", [0], false]) {
      assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, value }),
        { status: 422, code: "INVALID_RESPONSE" });
    }
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, questionVersion: 8 }),
      { status: 409, code: "QUESTION_REVISION_STALE" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(outsider, activity.activityId, save), { status: 403, code: "FORBIDDEN" });
    assert.deepEqual(deliveredView(runtime, activity), before);
    confirmation = { ...intent(activity, published.practice.questions.map(question =>
      revision(question, question.id === "missing-text" ? 0 : 1))), source: "whole" };
    const stale = { ...confirmation, questions: confirmation.questions.map(question =>
      question.questionId === "partial" ? { ...question, revision: 0 } : question) };
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, stale), error =>
      error instanceof QuestionDeliveryConflict && error.questionId === "partial" && error.current.revision === 1 &&
      JSON.stringify(error.current.value) === JSON.stringify(["  西风  "]));
    const submittedValues = { ...confirmation, questions: confirmation.questions.map(question =>
      question.questionId === "missing-text" ? { ...question, value: ["伪造"] } : question) };
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, submittedValues), ZodError);
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
    runtime.publish(orderedTextGroup(2));
    receipt = runtime.confirmQuestionDelivery(student, activity.activityId, confirmation);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, confirmation), receipt);
    assert.equal(observed.length, 0);
  } finally { runtime.close(); }

  const reopened = openLearningRuntime(config);
  try {
    const key = recoveryKey(confirmation);
    assert.throws(() => reopened.recoverQuestionDelivery(outsider, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => reopened.read(outsider, activity.activityId), { status: 403, code: "FORBIDDEN" });
    authorized = false;
    assert.throws(() => reopened.recoverQuestionDelivery(student, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.equal(observed.length, 0);
    authorized = true;
    const result = reopened.recoverQuestionDelivery(student, activity.activityId, key);
    assert.deepEqual(result.receipt, receipt);
    assert.deepEqual(result.practice, { id: published.practice.id, version: 1 });
    assert.deepEqual(result.confirmation.questions.map(({ questionId, revision, value }) => [questionId, revision, value]),
      [...initial.map(([id, value]) => [id, 1, value]), ["missing-text", 0, null]]);
    assert.deepEqual(observed.map(input => [input.questionId, input.questionVersion, input.value, input.acceptedBlanks]),
      [...initial.slice(1).map(([id, value]) => [id, 9, value, acceptedBlanks]), ["missing-text", 9, null, acceptedBlanks]]);
    assert.equal(result.evaluation.correctCount, 1);
    assert.equal(result.evaluation.needsReviewCount, 4);
    assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, key), result);
    assert.equal(observed.length, 5);
    const finished = deliveredView(reopened, activity);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.questionDeliveries, [{ receipt, questionDelivery: result.confirmation }]);
    assert.doesNotMatch(JSON.stringify([finished, result]), /acceptedBlanks|acceptedByQuestion|偏西/);
    assert.deepEqual(counts(databasePath), {
      practices: 2, scoring_keys: 2, activities: 1, submissions: 1, completions: 1, evaluation_tasks: 1, performances: 3,
    });
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(db.prepare("SELECT unit_id FROM performances ORDER BY unit_id").all().map(row => row.unit_id),
      ["question:choice", "question:extra", "question:partial"]);
  } finally { reopened.close(); }
});

test("有序文本必答只接受含非空白文本的数组，失败保留可编辑的明确空稿", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(orderedTextSettings(databasePath, () => true, []));
  const full = orderedTextGroup(1, false);
  const [question] = orderedTextQuestions;
  assert.ok(question);
  const publication = { practice: { ...full.practice, questions: [question] },
    scoringKey: { ...full.scoringKey, acceptedByQuestion: {
      partial: { response: "orderedTextBlanks", acceptedBlanks: [[], ["阴天"]] },
    } } } satisfies PublicationInput;
  try {
    runtime.publish(publication);
    const activity = open(runtime, publication.practice.id);
    const save = target(activity, question);
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...save, value: { body: "独立文字原值" } }),
      { status: 422, code: "INVALID_RESPONSE" });
    const confirm = (draftRevision: number) => runtime.confirmQuestionDelivery(student, activity.activityId,
      { ...intent(activity, [revision(question, draftRevision)]), source: "whole" });
    for (const [baseRevision, value] of [[0, []], [1, ["", "\r\n\u3000"]]] satisfies [number, string[]][]) {
      assert.throws(() => confirm(baseRevision), { status: 422, code: "UNANSWERED_QUESTION" });
      const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId,
        { ...save, value, baseRevision, operationId: `blank-${baseRevision}` });
      assert.deepEqual([saved.revision, saved.value], [baseRevision + 1, value]);
    }
    assert.throws(() => confirm(2), { status: 422, code: "UNANSWERED_QUESTION" });
    assert.equal(deliveredView(runtime, activity).status, "active");
    assert.deepEqual(deliveredView(runtime, activity).questionDeliveryDrafts.map(({ value }) => value), [["", "\r\n\u3000"]]);
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
    const set = runtime.saveQuestionDeliveryDraft(student, activity.activityId,
      { ...save, value: ["", " 阴天 ", ""], baseRevision: 2, operationId: "filled" });
    assert.ok(confirm(set.revision).id);
    assert.equal(deliveredView(runtime, activity).status, "completed");
  } finally { runtime.close(); }
});

test("有序文本声明拒绝错位私有键和缺少同版注册，失败不登记", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(settings(databasePath));
  const publication = orderedTextGroup();
  try {
    assert.throws(() => runtime.publish(publication), error => error instanceof ZodError &&
      error.issues.some(issue => issue.path.join(".") === "practice.grading.assessment.evaluator"));
  } finally { runtime.close(); }
  const registered = openLearningRuntime(orderedTextSettings(databasePath, () => true, []));
  try {
    const wrongKind = { response: "booleanOrString", acceptedResponse: true } as const;
    const wrongLength = { response: "orderedTextBlanks" as const, acceptedBlanks: [["西风"]] };
    const invalidCandidate = { response: "orderedTextBlanks" as const, acceptedBlanks: [[""], ["阴天"]] };
    function publishWith(partial: typeof wrongKind | typeof wrongLength) {
      registered.publish({ ...publication, scoringKey: { ...publication.scoringKey, acceptedByQuestion: {
        ...publication.scoringKey.acceptedByQuestion, partial,
      } } });
    }
    for (const basis of [wrongKind, wrongLength]) {
      assert.throws(() => publishWith(basis), error => error instanceof ZodError &&
        error.issues.some(issue => issue.path.join(".") === "scoringKey.acceptedByQuestion.partial"));
    }
    assert.throws(() => publishWith(invalidCandidate), ZodError);
    assert.throws(() => open(registered, publication.practice.id), { status: 404, code: "PRACTICE_NOT_FOUND" });
    assert.deepEqual(counts(databasePath), {
      practices: 0, scoring_keys: 0, activities: 0, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
  } finally { registered.close(); }
});

const titledText = "textWithOptionalTitle" as const;
const writtenQuestion = { id: "written", version: 2, prompt: "写下你的观察。", response: titledText };
const titledTextKey = { response: titledText };

function titledGroup(id: string, allowUnanswered: boolean, questions = [writtenQuestion]) {
  const key = { ...keyRef, id: `${id}-key` };
  return {
    practice: { ...base, id, questions, grading: { assessment: { ...grading.assessment, keyRef: key } }, policy: responsePolicy,
      steps: [{ ...step, tool: { id: "question-delivery", version: 1 },
        submit: { purpose: "finalAnswer", slots: { answers: {
          type: "questionDelivery", ...slot, confirmFromDrafts: { allowUnanswered }, delivery: { mode: "whole" },
        } } },
      }],
    },
    scoringKey: { ...key, acceptedByQuestion: Object.fromEntries(questions.map(question => [question.id, titledTextKey])) },
  } satisfies PublicationInput;
}

test("带可选标题的正文发布要求专用精确版本评估器", t => {
  const runtime = openLearningRuntime(settings(scenarioDatabase(t)));
  try {
    assert.throws(() => runtime.publish(titledGroup("written-assessment", false)),
      (error: unknown) => error instanceof ZodError
      && error.issues.some(issue => issue.message === "未注册 textWithOptionalTitle 所需的精确评估版本"));
  } finally { runtime.close(); }
});


function titledSettings(databasePath: string, evaluate: (input: TitledTextEvaluationInput) => { status: "needsReview" } = () => ({ status: "needsReview" })) {
  return { ...settings(databasePath), titledTextEvaluators: [{ ...evaluator, evaluate }] };
}

test("必答按正文拒绝仅标题，拒绝不写确认、评估任务或表现", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(titledSettings(databasePath));
  try {
    const publication = titledGroup("required-written", false);
    runtime.publish(publication);
    const activity = open(runtime, publication.practice.id);
    const save = target(activity, writtenQuestion);
    const confirm = (atRevision: number) => runtime.confirmQuestionDelivery(student, activity.activityId, {
      ...intent(activity, [revision(writtenQuestion, atRevision)]), source: "whole",
    });
    const failure = { status: 422, code: "UNANSWERED_QUESTION" };
    assert.throws(() => confirm(0), failure);
    const title = "  仅标题  ";
    for (const [baseRevision, body] of ["", " \r\n\u3000"].entries()) {
      const value = { body, title };
      const draft = runtime.saveQuestionDeliveryDraft(student, activity.activityId,
        { ...save, value, baseRevision, operationId: `blank-${baseRevision}` });
      assert.equal(draft.revision, baseRevision + 1);
      assert.deepEqual(draft.value, value);
      assert.throws(() => confirm(draft.revision), failure);
      assert.equal(deliveredView(runtime, activity).status, "active");
      assert.deepEqual(deliveredView(runtime, activity).questionDeliveryDrafts, [draft]);
    }
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
    const draft = runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
      ...save, baseRevision: 2, operationId: "text", value: { body: "  正文  ", title },
    });
    assert.ok(confirm(draft.revision).id);
    assert.deepEqual(counts(databasePath), {
      practices: 1, scoring_keys: 1, activities: 1, submissions: 1, completions: 1, evaluation_tasks: 1, performances: 1,
    });
  } finally { runtime.close(); }
});

test("文字原稿精确重开，缺稿与空正文分离，旧版回执和评估仅执行一次", t => {
  const databasePath = scenarioDatabase(t);
  const recorded: TitledTextEvaluationInput[] = [];
  let mayRecover = true;
  const evaluationV2 = { ...evaluator, version: 2 };
  const baseConfig = titledSettings(databasePath, input => {
    recorded.push(input);
    return { status: "needsReview" };
  });
  const config = {
    ...baseConfig, authorizeConfirmationRecovery: () => mayRecover,
    titledTextEvaluators: [...baseConfig.titledTextEvaluators, { ...evaluationV2, evaluate() { throw new Error("须使用冻结评估版本"); } }],
  };
  const questions = ["empty", "whitespace", "omitted-title", "empty-title", "missing"].map(id => ({ ...writtenQuestion, id }));
  const body = "  第一段\n\n第二段  ";
  const raw = [{ body: "", title: "  原标题  " }, { body: " \t\n\u3000", title: "标题" }, { body }, { body, title: "" }, null];
  const publication = titledGroup("optional-written", true, questions);
  const activityAndRequest = (() => {
    const runtime = openLearningRuntime(config);
    try {
      runtime.publish(publication);
      const activity = open(runtime, publication.practice.id);
      const frozen = questions.map((question, index) => {
        const value = raw[index];
        if (!value) return revision(question, 0);
        const input = { ...target(activity, question), value };
        const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, input);
        assert.deepEqual(runtime.saveQuestionDeliveryDraft(student, activity.activityId, input), saved);
        assert.deepEqual(saved.value, value);
        return revision(question, saved.revision);
      });
      const key = { ...publication.scoringKey, version: 2 };
      runtime.publish({ practice: {
        ...publication.practice, version: 2,
        questions: questions.map(question => ({ ...question, version: 4 })),
        grading: { assessment: { ...grading.assessment, evaluator: evaluationV2, keyRef: { id: key.id, version: key.version } } },
      }, scoringKey: key });
      return { activity, request: { ...intent(activity, frozen), source: "whole" } as const };
    } finally { runtime.close(); }
  })();
  const { activity, request } = activityAndRequest;
  const write = openLearningRuntime({ ...config, titledTextEvaluators: config.titledTextEvaluators.slice(1) });
  let receipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  const key = recoveryKey(request);
  try {
    const drafts = new Map(deliveredView(write, activity).questionDeliveryDrafts.map(item => [item.questionId, item.value]));
    assert.deepEqual(questions.map(({ id }) => drafts.get(id) ?? null), raw);
    receipt = write.confirmQuestionDelivery(student, activity.activityId, request);
    assert.deepEqual(write.confirmQuestionDelivery(student, activity.activityId, request), receipt);
    assert.throws(() => write.recoverQuestionDelivery(student, activity.activityId, key),
      { status: 503, code: "EVALUATOR_UNAVAILABLE" });
    assert.equal(recorded.length, 0);
    assert.deepEqual(counts(databasePath), {
      practices: 2, scoring_keys: 2, activities: 1, submissions: 1, completions: 1, evaluation_tasks: 1, performances: 2,
    });
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT status FROM evaluation_tasks").get()?.status, "pending");
  } finally { write.close(); }

  const runtime = openLearningRuntime(config);
  try {
    const result = runtime.recoverQuestionDelivery(student, activity.activityId, key);
    assert.deepEqual(result.receipt, receipt);
    assert.deepEqual(result.confirmation.questions.map(question => [question.revision, question.value]),
      raw.map(value => [value === null ? 0 : 1, value]));
    assert.deepEqual(result.draftChangeCounts.map(({ changeCount }) => changeCount), [1, 1, 1, 1, 0]);
    assert.deepEqual(result.practice, { id: publication.practice.id, version: 1 });
    assert.deepEqual(result.evaluation.evaluator, evaluator);
    assert.equal(result.evaluation.needsReviewCount, 5);
    assert.equal(result.evaluation.correctCount, 0);
    assert.deepEqual(recorded, questions.map((question, index) => ({
      activityId: activity.activityId, stepAttemptId: activity.stepAttemptId, slotId: "answers",
      practice: { id: publication.practice.id, version: 1 }, questionId: question.id, questionVersion: question.version, value: raw[index],
    })));
    const view = deliveredView(runtime, activity);
    assert.deepEqual(view.questionDeliveries, [{ receipt, questionDelivery: result.confirmation }]);
    assert.doesNotMatch(JSON.stringify(view), /acceptedByQuestion|needsReview|delivery-key/);
    assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, key), result);
    mayRecover = false;
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, request), { status: 403, code: "FORBIDDEN" });
    assert.equal(recorded.length, 5);
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT status FROM evaluation_tasks").get()?.status, "done");
    assert.deepEqual(db.prepare("SELECT unit_id AS unit FROM performances ORDER BY unit_id").all().map(row => row.unit),
      ["question:empty-title", "question:omitted-title"]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM response_review_requirements").get()?.n, 5);
  } finally { runtime.close(); }
});

test("文字值和私有形态严格隔离，空标题变化单独推进修订", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(titledSettings(databasePath));
  try {
    const written = titledGroup("isolated-written", false);
    const wrongShape = { response: "booleanOrString", acceptedResponse: true } as const;
    const publicationWithKey = (basis: unknown) => ({ ...written, scoringKey: {
      ...written.scoringKey, acceptedByQuestion: { written: basis },
    } });
    const scalar = responseGroup("isolated-scalar", "booleanOrString");
    for (const candidate of [
      publicationWithKey(wrongShape), publicationWithKey({ ...titledTextKey, acceptedAnswer: "私有标记" }),
      { practice: { ...scalar.practice, questions: [writtenQuestion] }, scoringKey: scalar.scoringKey },
      { ...written, practice: { ...written.practice, grading: { assessment: { ...written.practice.grading.assessment, evaluator: { ...evaluator, version: 2 } } } } },
    ]) {
      assert.throws(() => Reflect.apply(runtime.publish, runtime, [candidate]), ZodError);
    }
    assert.deepEqual(counts(databasePath), {
      practices: 0, scoring_keys: 0, activities: 0, submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0,
    });
    runtime.publish(written);
    runtime.publish(scalar);
    const activity = open(runtime, written.practice.id);
    const input = target(activity, writtenQuestion);
    for (const value of [{ title: "无正文" }, { body: 2 }, { body: "", title: null }, { body: "", title: 4 }, { body: "", kind: "其它" }, null]) {
      assert.throws(() => Reflect.apply(runtime.saveQuestionDeliveryDraft, runtime, [student, activity.activityId, { ...input, value }]), ZodError);
    }
    for (const value of ["纯字符串", false, [0], ["原槽"], []]) {
      assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...input, value }),
        { status: 422, code: "INVALID_RESPONSE" });
    }
    assert.deepEqual(deliveredView(runtime, activity).questionDeliveryDrafts, []);
    const body = "正文";
    const first: ReturnType<Runtime["saveQuestionDeliveryDraft"]> = Reflect.apply(runtime.saveQuestionDeliveryDraft, runtime,
      [student, activity.activityId, { ...input, value: { body, title: undefined } }]);
    assert.deepEqual(first, runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...input, value: { body } }));
    assert.deepEqual(first.value, { body });
    const different = { ...input, value: { body, title: "" } };
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, different),
      { status: 409, code: "OPERATION_CONFLICT" });
    const second = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...different, operationId: "title", baseRevision: 1 });
    const third = runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
      ...input, operationId: "body", baseRevision: 2, value: { body: "另一段", title: "" },
    });
    assert.deepEqual([second.revision, second.value, third.revision, third.value], [2, { body, title: "" }, 3, { body: "另一段", title: "" }]);

    const plain = open(runtime, scalar.practice.id);
    const scalarInput = { ...target(plain, judgeQuestion), value: { body } };
    assert.throws(() => Reflect.apply(runtime.saveResponseDraft, runtime, [student, plain.activityId, scalarInput]), ZodError);
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, plain.activityId, scalarInput),
      { status: 422, code: "INVALID_SLOT" });
    const mixed = mixedGroup();
    runtime.publish(mixed);
    const legacy = open(runtime, mixed.practice.id);
    for (const [question, code] of [[strictChoice, "INVALID_CHOICE"], [judgeQuestion, "INVALID_RESPONSE"], [selectedIndexes, "INVALID_OPTION_INDEX"]] as const) {
      assert.throws(() => runtime.saveQuestionDeliveryDraft(student, legacy.activityId, { ...target(legacy, question), value: { body } }),
        { status: 422, code });
    }
    assert.deepEqual(deliveredView(runtime, legacy).questionDeliveryDrafts, []);
  } finally { runtime.close(); }
});
