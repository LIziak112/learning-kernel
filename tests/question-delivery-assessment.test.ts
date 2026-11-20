import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput, QuestionDeliveryDraftInput, QuestionDeliveryInput } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "delivery-assessment-student" } as const;
const outsider = { ...student, id: "delivery-assessment-outsider" };
const reviewer = { role: "reviewer", id: "reflection-reviewer" } as const;
const question = { id: "reflection", version: 4, prompt: "写一段观察。", response: "textWithOptionalTitle" } as const;
const judge = { id: "binary-observation", version: 9, prompt: "两份记录是否一致？", response: "booleanOrString",
  options: { yes: "是", no: "否" } } as const;
const optional = { ...question, id: "footnote", version: 2 };
const omitted = { ...question, id: "afterthought", version: 1 };
const slotId = "work";
const evaluator = { id: "reflection-evaluator", version: 2 };
const keyRef = { id: "reflection-key", version: 3 };
const basis = { id: "private-reflection-rubric", version: 6, reviewCriteria: "核对证据与结论的关联，说明一处可改进的理由。" };
const manualReview = { keyRef: { id: basis.id, version: basis.version } };
const answerRule = { id: "body-presence", version: 3 };
const original = { state: "frozen", documentId: "observe-document", versionId: "observe-frozen-1", sha256: "a".repeat(64) } as const;
const note = { body: "  日照时间较短，水蒸气凝结较多。\n", title: "" };
const titleOnly = { body: "  ", title: "附注" };
const step = {
  id: "deliver", instructions: "保留观察原文。", tool: { id: "question-delivery", version: 1 },
  inputs: { questions: { from: "questions" } },
  submit: { purpose: "finalAnswer", slots: { [slotId]: {
    type: "questionDelivery", source: "questions", targetId: "observe", delivery: { mode: "whole" },
    confirmFromDrafts: { allowUnanswered: true },
  } } },
  afterConfirmation: "finish",
} as const;
const automatic = {
  assessment: { from: { stepId: step.id, slotId }, evaluator, keyRef, unit: "question",
    effectiveVerdictOrder: ["teacherReview", "automatic"] as ["teacherReview", "automatic"] },
} as const;
const scoringKey = { ...keyRef, acceptedByQuestion: { [question.id]: { response: question.response } } };

type Runtime = ReturnType<typeof openLearningRuntime>;
type Activity = ReturnType<Runtime["start"]>;

function publication(id: string) {
  return {
    practice: {
      id, version: 1, formatVersion: 1, title: "合成观察作业",
      goals: { observe: "完成并提交观察" }, questions: [question], steps: [step], grading: {},
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  } satisfies PublicationInput;
}

function start(runtime: Runtime, id: string) {
  return runtime.start(student, { protocolVersion: 1, practiceId: id, practiceVersion: 1, operationId: "start-" + id });
}

function save(runtime: Runtime, activity: Activity, target: { id: string; version: number } = question, value: QuestionDeliveryDraftInput["value"] = note) {
  return runtime.saveQuestionDeliveryDraft(student, activity.activityId, { protocolVersion: 1, stepAttemptId: activity.stepAttemptId,
    slotId, questionId: target.id, questionVersion: target.version, operationId: "save", baseRevision: 0, value });
}

function confirmation(
  { stepAttemptId }: Activity, questions: QuestionDeliveryInput["questions"], source: "whole" | "finish" = "whole",
): QuestionDeliveryInput {
  return { protocolVersion: 1, stepAttemptId, slotId, source, operationId: source, questions };
}

function revision({ id: questionId, version: questionVersion }: { id: string; version: number }, number: number) {
  return { questionId, questionVersion, revision: number, original };
}

function recoveryKey({ protocolVersion, operationId, stepAttemptId }: QuestionDeliveryInput) {
  return { protocolVersion, operationId, stepAttemptId };
}

function facts(path: string) {
  using database = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  return Object.fromEntries([
    "submissions", "completions", "scoring_keys", "evaluation_tasks", "automatic_verdicts", "response_review_requirements", "performances",
  ].map(table => [table, database.prepare("SELECT count(*) AS n FROM " + table).get()?.n]));
}

test("仅收作品的已发布题组可确认、按现行权限重开，保持原文、回执和零评估事实", t => {
  const databasePath = scenarioDatabase(t);
  let allowed = true;
  let verified = 0;
  const first = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => allowed,
    verifyOriginal(scope) { verified += 1; return scope.questionId === question.id && scope.original.state === "frozen"; },
  });
  const base = publication("collection");
  const attempt = (() => {
    try {
      first.publish(base);
      const activity = start(first, base.practice.id);
      const saved = save(first, activity);
      const input = confirmation(activity, [revision(question, saved.revision)]);
      const receipt = first.confirmQuestionDelivery(student, activity.activityId, input);
      assert.deepEqual(first.confirmQuestionDelivery(student, activity.activityId, input), receipt);
      assert.equal(verified, 1);
      return { activity, input, receipt };
    } finally { first.close(); }
  })();
  const { activity, input, receipt } = attempt;
  const second = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => allowed });
  try {
    const view = second.read(student, activity.activityId);
    assert.equal(view.status, "completed");
    assert.ok("questionDeliveries" in view);
    assert.deepEqual(view.questionDeliveries, [{ receipt, questionDelivery: {
      source: "whole", slotId, questions: [{ ...input.questions[0], value: note }],
    } }]);
    assert.deepEqual(second.confirmQuestionDelivery(student, activity.activityId, input), receipt);
    const key = recoveryKey(input);
    const recovered = second.recoverQuestionDelivery(student, activity.activityId, key, "declared");
    assert.equal(recovered.assessment, "none");
    assert.equal(Object.hasOwn(recovered, "evaluation"), false);
    assert.equal(Object.hasOwn(recovered, "review"), false);
    assert.deepEqual(recovered.receipt, receipt);
    assert.deepEqual(recovered.confirmation, view.questionDeliveries[0]?.questionDelivery);
    assert.deepEqual(recovered.requestQuestions, input.questions);
    assert.deepEqual(recovered.draftChangeCounts, [{ questionId: question.id, changeCount: 1 }]);
    assert.deepEqual(second.recoverQuestionDelivery(student, activity.activityId, key, "declared"), recovered);
    assert.throws(() => second.recoverQuestionDelivery(student, activity.activityId, key), { code: "ASSESSMENT_MODE_MISMATCH" });
    assert.throws(() => second.recoverQuestionDelivery(outsider, activity.activityId, key, "declared"), { code: "FORBIDDEN" });
    allowed = false;
    assert.throws(() => second.recoverQuestionDelivery(student, activity.activityId, key, "declared"), { code: "FORBIDDEN" });
    assert.throws(() => second.confirmQuestionDelivery(student, activity.activityId, input), { code: "FORBIDDEN" });
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 0, evaluation_tasks: 0,
      automatic_verdicts: 0, response_review_requirements: 0, performances: 1 });
  } finally { second.close(); }
});

test("人工评阅与逐题确认同事务登记，按旧确认重开实际量表和待评题", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("manual");
  const questions = [question, optional, omitted];
  const individualStep = { ...step, submit: { ...step.submit, slots: { [slotId]: { ...step.submit.slots[slotId],
    delivery: { mode: "perQuestion", questionSlots: { [question.id]: "first", [optional.id]: "second", [omitted.id]: "third" } } as const,
  } } } };
  const manual = { practice: { ...base.practice, grading: { manualReview }, questions,
    questionAnswerRules: { [optional.id]: answerRule },
    steps: [individualStep] satisfies [typeof individualStep],
  }, scoringKey: basis };
  let allowed = false;
  let reviewerAllowed = true;
  let verified = false;
  const first = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => allowed,
    verifyOriginal: () => verified,
    questionAnswerRules: [{ ...answerRule, response: question.response, isAnswered: value => value.body.trim() !== "" }],
  });
  const saved = (() => {
    try {
      first.publish(manual);
      const activity = start(first, manual.practice.id);
      const draft = save(first, activity);
      const record = revision(question, draft.revision);
      const input: QuestionDeliveryInput = { ...confirmation(activity, [record]),
        source: "question", operationId: "question", questions: [record] };
      assert.throws(() => first.confirmQuestionDelivery(student, activity.activityId, input), { code: "ORIGINAL_NOT_VERIFIED" });
      assert.deepEqual(facts(databasePath), { submissions: 0, completions: 0, scoring_keys: 1, evaluation_tasks: 0,
        automatic_verdicts: 0, response_review_requirements: 0, performances: 0 });
      verified = true;
      using database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TRIGGER abort_review_requirement BEFORE INSERT ON response_review_requirements
        BEGIN SELECT RAISE(ABORT, 'fixture review insert failed'); END
      `);
      assert.throws(() => first.confirmQuestionDelivery(student, activity.activityId, input), /fixture review insert failed/);
      assert.deepEqual(facts(databasePath), { submissions: 0, completions: 0, scoring_keys: 1, evaluation_tasks: 0,
        automatic_verdicts: 0, response_review_requirements: 0, performances: 0 });
      database.exec("DROP TRIGGER abort_review_requirement");
      const receipt = first.confirmQuestionDelivery(student, activity.activityId, input);
      assert.throws(() => first.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input)), { code: "FORBIDDEN" });
      assert.equal(facts(databasePath).response_review_requirements, 1);
      assert.throws(() => first.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input), "declared"), { code: "FORBIDDEN" });
      allowed = true;
      assert.deepEqual(first.confirmQuestionDelivery(student, activity.activityId, input), receipt);
      const last = save(first, activity, optional, titleOnly);
      const finish = confirmation(activity, [record, revision(optional, last.revision), revision(omitted, 0)], "finish");
      const finishReceipt = first.confirmQuestionDelivery(student, activity.activityId, finish);
      const changedBasis = { ...basis, version: basis.version + 1, reviewCriteria: "新版评阅要求补充对照。" };
      const newer = { ...manual.practice, grading: { manualReview: { keyRef: { id: changedBasis.id, version: changedBasis.version } } } };
      assert.throws(() => first.publish({ practice: newer, scoringKey: changedBasis }), /版本不能更改/);
      first.publish({ practice: { ...newer, version: 2 }, scoringKey: changedBasis });
      return { activity, input, receipt, finish, finishReceipt };
    } finally { first.close(); }
  })();
  const runtime = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => allowed,
    authorizeQuestionDeliveryReview(scope) {
      return reviewerAllowed && scope.reviewerId === reviewer.id && scope.studentId === student.id
        && scope.activityId === saved.activity.activityId && scope.stepAttemptId === saved.activity.stepAttemptId
        && scope.operationId === saved.input.operationId && scope.submissionId === saved.receipt.id && scope.slotId === "first";
    },
  });
  try {
    const { activity, input, receipt, finish, finishReceipt } = saved;
    const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input), "declared");
    assert.equal(recovered.assessment, "manual");
    assert.deepEqual(recovered.receipt, receipt);
    assert.deepEqual(recovered.confirmation.questions, [{ ...input.questions[0], value: note }]);
    assert.deepEqual(recovered.review, { questions: [{ questionId: question.id, questionVersion: question.version, status: "needsReview" }] });
    assert.doesNotMatch(JSON.stringify(recovered), /private-reflection-rubric|核对证据|reviewCriteria/);
    const review = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input));
    assert.deepEqual(review.basis, basis);
    assert.deepEqual(review.receipt, receipt);
    assert.deepEqual(review.confirmation, recovered.confirmation);
    assert.deepEqual(review.questions, recovered.review.questions);
    assert.deepEqual(runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input)), review);
    assert.throws(() => runtime.readQuestionDeliveryReview({ ...reviewer, id: "other-reviewer" }, activity.activityId, recoveryKey(input)),
      { code: "FORBIDDEN" });
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(finish)), { code: "FORBIDDEN" });
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activity.activityId,
      { ...recoveryKey(input), operationId: "another-confirmation" }), { code: "FORBIDDEN" });
    using database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO reading_reviews (activity_id, reviewer_id, reviewer_active) VALUES (?, ?, 0)").run(activity.activityId, reviewer.id);
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input)), { code: "FORBIDDEN" });
    database.prepare("UPDATE reading_reviews SET reviewer_active = 1 WHERE activity_id = ?").run(activity.activityId);
    assert.deepEqual(runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input)), review);
    reviewerAllowed = false;
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input)), { code: "FORBIDDEN" });
    assert.equal(Object.hasOwn(recovered, "evaluation"), false);
    const ended = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(finish), "declared");
    assert.equal(ended.assessment, "manual");
    assert.deepEqual(ended.receipt, finishReceipt);
    assert.deepEqual(ended.review, { questions: [optional, omitted].map(({ id: questionId, version: questionVersion }) =>
      ({ questionId, questionVersion, status: "needsReview" })) });
    assert.deepEqual(ended.confirmation.questions, [{ ...finish.questions[1], value: titleOnly }, { ...finish.questions[2], value: null }]);
    assert.deepEqual(ended.requestQuestions, finish.questions);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, input), receipt);
    const view = runtime.read(student, activity.activityId);
    assert.equal(view.status, "completed");
    assert.doesNotMatch(JSON.stringify(view), /manualReview|private-reflection-rubric|核对证据|needsReview|acceptedByQuestion/);
    assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, recoveryKey(input), "declared"), { code: "FORBIDDEN" });
    allowed = false;
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input), "declared"), { code: "FORBIDDEN" });
    assert.deepEqual(facts(databasePath), { submissions: 2, completions: 1, scoring_keys: 2, evaluation_tasks: 2,
      automatic_verdicts: 0, response_review_requirements: 3, performances: 1 });
  } finally { runtime.close(); }
});

test("自动题组按旧调用读取精确评估事实，声明式回读与其一致", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("automatic");
  const automaticPublication = {
    practice: { ...base.practice, questions: [judge], grading: automatic },
    scoringKey: { ...keyRef, acceptedByQuestion: { [judge.id]: { response: judge.response, acceptedResponse: false } } },
  };
  const settings = { databasePath, authorizeConfirmationRecovery: () => true };
  let evaluated = 0;
  const first = openLearningRuntime({ ...settings, verifyOriginal: () => true,
    responseEvaluators: [{ ...evaluator, evaluate({ value, questionVersion, acceptedResponse }) {
      evaluated += 1;
      assert.equal(value, false);
      assert.equal(questionVersion, judge.version);
      assert.equal(acceptedResponse, false);
      return { status: "judged", correct: value === acceptedResponse };
    } }],
  });
  const saved = (() => {
    try {
      first.publish(automaticPublication);
      const activity = start(first, base.practice.id);
      const draft = save(first, activity, judge, false);
      const input = confirmation(activity, [revision(judge, draft.revision)]);
      const receipt = first.confirmQuestionDelivery(student, activity.activityId, input);
      const evaluation = first.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input));
      assert.equal(evaluation.evaluation.correctCount, 1);
      assert.equal(evaluated, 1);
      return { activity, input, receipt, evaluation };
    } finally { first.close(); }
  })();
  const { activity, input, receipt, evaluation } = saved;
  const runtime = openLearningRuntime(settings);
  try {
    const key = recoveryKey(input);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, input), receipt);
    assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, key), evaluation);
    assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared"),
      { ...evaluation, assessment: "automatic" });
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 1, evaluation_tasks: 1,
      automatic_verdicts: 1, response_review_requirements: 0, performances: 1 });
    assert.equal(evaluated, 1);
  } finally { runtime.close(); }
});

test("发布拒绝多重评估、无实际量表的人工评阅、无评估的评分键和缺少评分键的自动评估", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath, titledTextEvaluators: [{ ...evaluator, evaluate: () => ({ status: "needsReview" }) }] });
  const base = publication("invalid");
  try {
    assert.throws(() => runtime.publish({ ...base, scoringKey }), ZodError);
    assert.throws(() => runtime.publish({ practice: { ...base.practice, grading: automatic } }), ZodError);
    assert.throws(() => runtime.publish({ practice: { ...base.practice,
      grading: { ...automatic, manualReview },
    }, scoringKey }), ZodError);
    assert.throws(() => runtime.publish({ practice: { ...base.practice, grading: { ...automatic, manualReview } },
      scoringKey: basis }), ZodError);
    assert.throws(() => runtime.publish({ practice: { ...base.practice, grading: { manualReview } }, scoringKey }), ZodError);
    assert.throws(() => runtime.publish({ practice: { ...base.practice, grading: { manualReview } },
      scoringKey: { ...basis, reviewCriteria: "  " } }), ZodError);
    assert.throws(() => runtime.publish({ practice: { ...base.practice, grading: { manualReview } },
      scoringKey: { ...basis, version: basis.version + 1 } }), ZodError);
    const legacyStep = { ...step, tool: { id: "single-choice-group", version: 1 }, submit: { ...step.submit, slots: {
      [slotId]: { type: "oneChoicePerQuestion", source: "questions", targetId: "observe" },
    } } } as const;
    assert.throws(() => runtime.publish({ practice: { ...base.practice,
      questions: [{ id: "choice", version: 1, prompt: "选择最清楚的描述。", options: { a: "凝结", b: "干燥" } }],
      steps: [legacyStep], grading: { manualReview }, policy: { ...base.practice.policy,
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt"], onFinal: [] } },
      },
    } }), error => error instanceof ZodError && error.issues.some(issue => issue.path.join(".") === "practice.grading.manualReview"));
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM practices").get()?.n, 0);
  } finally { runtime.close(); }
});
