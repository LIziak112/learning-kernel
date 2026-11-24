import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput, QuestionDeliveryDraftInput, QuestionDeliveryInput, ReviewScope } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";
import { answerRule as answerRuleOf, reviewAccess, booleanEvaluator, combinedEvaluator, orderedTextEvaluator, titledTextEvaluator, titledValue } from "./fixtures/evaluators.ts";

const reviewAnchorVersion = 19;
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
        reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] }, manager: { scope: "assigningTeacher", actions: [] },
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
      first.evaluatePending();
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
    questionAnswerRules: [answerRuleOf(answerRule, question.response, titledValue, value => value.body.trim() !== "")],
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
      first.evaluatePending();
      assert.throws(() => first.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(input)), { code: "FORBIDDEN" });
      assert.equal(facts(databasePath).response_review_requirements, 1);
      assert.throws(() => first.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input), "declared"), { code: "FORBIDDEN" });
      allowed = true;
      assert.deepEqual(first.confirmQuestionDelivery(student, activity.activityId, input), receipt);
      const last = save(first, activity, optional, titleOnly);
      const finish = confirmation(activity, [record, revision(optional, last.revision), revision(omitted, 0)], "finish");
      const finishReceipt = first.confirmQuestionDelivery(student, activity.activityId, finish);
      first.evaluatePending();
      const changedBasis = { ...basis, version: basis.version + 1, reviewCriteria: "新版评阅要求补充对照。" };
      const newer = { ...manual.practice, grading: { manualReview: { keyRef: { id: changedBasis.id, version: changedBasis.version } } } };
      assert.throws(() => first.publish({ practice: newer, scoringKey: changedBasis }), /版本不能更改/);
      first.publish({ practice: { ...newer, version: 2 }, scoringKey: changedBasis });
      return { activity, input, receipt, finish, finishReceipt };
    } finally { first.close(); }
  })();
  const runtime = openLearningRuntime({ databasePath, authorizeConfirmationRecovery: () => allowed,
    authorizeReview: reviewAccess({ questionDelivery: { read: scope => reviewerAllowed && scope.reviewerId === reviewer.id
      && scope.studentId === student.id && scope.activityId === saved.activity.activityId && scope.stepAttemptId === saved.activity.stepAttemptId
      && scope.operationId === saved.input.operationId && scope.submissionId === saved.receipt.id && scope.slotId === "first" } }),
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
    evaluators: [booleanEvaluator(evaluator, ({ value, questionVersion, acceptedResponse }) => {
      evaluated += 1;
      assert.equal(value, false);
      assert.equal(questionVersion, judge.version);
      assert.equal(acceptedResponse, false);
      return { status: "judged", correct: value === acceptedResponse };
    })],
  });
  const saved = (() => {
    try {
      first.publish(automaticPublication);
      const activity = start(first, base.practice.id);
      const draft = save(first, activity, judge, false);
      const input = confirmation(activity, [revision(judge, draft.revision)]);
      const receipt = first.confirmQuestionDelivery(student, activity.activityId, input);
      first.evaluatePending();
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
  const runtime = openLearningRuntime({ databasePath, evaluators: [titledTextEvaluator(evaluator, () => ({ status: "needsReview" }))] });
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

test("题组教师改判｜连续改判逐次撤销回落到上一条有效教师改判，再回落到自动原判或待评", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("mixed-verdict");
  let allowed = true;
  let reviewedSubmission: string | undefined;
  let evaluated = 0;
  const owns = (scope: ReviewScope) => allowed && scope.reviewerId === reviewer.id && scope.studentId === student.id
    && scope.submissionId === reviewedSubmission && scope.slotId === slotId;
  const settings = {
    databasePath, authorizeConfirmationRecovery: () => true, verifyOriginal: () => true,
    authorizeReview: reviewAccess({ questionDelivery: { read: owns, write: owns } }),
  };
  const runtime = openLearningRuntime({ ...settings,
    evaluators: [combinedEvaluator(titledTextEvaluator(evaluator, () => { evaluated += 1; return { status: "needsReview" }; }),
      booleanEvaluator(evaluator, ({ value, acceptedResponse }) => {
        evaluated += 1;
        return { status: "judged", correct: value === acceptedResponse };
      }))],
  });
  const committed = (() => {
    try {
      runtime.publish({ practice: { ...base.practice, questions: [judge, question], grading: automatic },
        scoringKey: { ...scoringKey, acceptedByQuestion: {
          ...scoringKey.acceptedByQuestion, [judge.id]: { response: judge.response, acceptedResponse: false },
        } },
      });
      const activity = start(runtime, base.practice.id);
      const { activityId } = activity;
      const draft = save(runtime, activity, judge, false);
      const essay = save(runtime, activity, question, note);
      const input = confirmation(activity, [revision(judge, draft.revision), revision(question, essay.revision)]);
      const receipt = runtime.confirmQuestionDelivery(student, activityId, input);
      reviewedSubmission = receipt.id;
      const key = recoveryKey(input);
      const read = () => runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts");
      assert.deepEqual(read().questions.map(({ revision, status }) => ({ revision, status })),
        [{ revision: 0, status: "pendingEvaluation" }, { revision: 0, status: "pendingEvaluation" }]);
      assert.equal(evaluated, 0);
      runtime.evaluatePending();
      const automaticBefore = runtime.recoverQuestionDelivery(student, activityId, key);
      assert.equal(evaluated, 2);
      const readBefore = read();
      assert.doesNotMatch(JSON.stringify(readBefore), /reflection-key|acceptedByQuestion|acceptedResponse/);
      const correct = { source: "automatic", correct: true };
      assert.deepEqual(readBefore.questions, [
        { questionId: judge.id, questionVersion: judge.version, revision: 0, status: "judged",
          automatic: { correct: true, valid: true }, effective: correct },
        { questionId: question.id, questionVersion: question.version, revision: 0, status: "needsReview" },
      ]);
      const studentBefore = runtime.read(student, activityId);
      const command = {
        protocolVersion: 1, action: "override", operationId: "mark-first", expectedRevision: 0,
        submissionId: receipt.id, targetId: "observe", questionId: judge.id, reason: "独立复核依据仅供教师", correct: false,
      } as const;
      const first = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, command);
      assert.equal(first.revision, 1);
      assert.deepEqual(read().questions, [{
        ...readBefore.questions[0], revision: 1, effective: { source: "teacherReview", id: first.id, correct: false },
      }, readBefore.questions[1]]);
      assert.deepEqual(runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), first);
      assert.deepEqual(runtime.recoverQuestionDelivery(student, activityId, key), automaticBefore);
      assert.deepEqual(runtime.read(student, activityId), studentBefore);
      assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, { ...command, correct: true }),
        { code: "OPERATION_CONFLICT" });
      assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, { ...command, operationId: "stale-write" }),
        { code: "VERDICT_CONFLICT" });
      const next = { ...command, operationId: "mark-second", expectedRevision: 1, correct: true };
      const second = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, next);
      assert.equal(second.revision, 2);
      const clear = { ...command, action: "withdraw", operationId: "clear", expectedRevision: 2, withdrawId: second.id } as const;
      const { correct: _correct, ...withdraw } = clear;
      assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, { ...withdraw, withdrawId: first.id }),
        { code: "VERDICT_CONFLICT" });
      const cleared = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, withdraw);
      assert.equal(cleared.revision, 3);
      assert.deepEqual(read().questions, [{
        ...readBefore.questions[0], revision: 3, effective: { source: "teacherReview", id: first.id, correct: false },
      }, readBefore.questions[1]]);
      assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key,
        { ...withdraw, operationId: "clear-stale", expectedRevision: 3 }), { code: "VERDICT_CONFLICT" });
      const reverted = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key,
        { ...withdraw, operationId: "clear-first", expectedRevision: 3, withdrawId: first.id });
      assert.equal(reverted.revision, 4);
      assert.deepEqual(read().questions, [{ ...readBefore.questions[0], revision: 4 }, readBefore.questions[1]]);
      const send = { ...command, operationId: "mark-waiting", questionId: question.id };
      const waiting = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, send);
      assert.equal(waiting.revision, 1);
      const whileMarked = read();
      assert.deepEqual(whileMarked.questions[1], {
        ...readBefore.questions[1], revision: 1, status: "judged", effective: { source: "teacherReview", id: waiting.id, correct: false },
      });
      assert.deepEqual(whileMarked.questions[0], { ...readBefore.questions[0], revision: 4 });
      runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key,
        { ...withdraw, operationId: "clear-waiting", questionId: question.id, expectedRevision: 1, withdrawId: waiting.id });
      assert.deepEqual(read().questions, [{ ...readBefore.questions[0], revision: 4 }, { ...readBefore.questions[1], revision: 2 }]);
      assert.deepEqual(runtime.recoverQuestionDelivery(student, activityId, key), automaticBefore);
      assert.deepEqual(runtime.read(student, activityId), studentBefore);
      assert.doesNotMatch(JSON.stringify(studentBefore), /独立复核依据|teacherReview|acceptedByQuestion/);
      assert.deepEqual(runtime.confirmQuestionDelivery(student, activityId, input), receipt);
      return { activityId, key, command, first, withdraw, cleared, final: read() };
    } finally { runtime.close(); }
  })();
  const { activityId, key, command, first, withdraw, cleared } = committed;
  const reopened = openLearningRuntime(settings);
  try {
    assert.deepEqual(reopened.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts"), committed.final);
    assert.deepEqual(reopened.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), first);
    assert.deepEqual(reopened.writeQuestionDeliveryVerdict(reviewer, activityId, key, withdraw), cleared);
    const forbidden = { code: "FORBIDDEN" };
    const readOnly = openLearningRuntime({ databasePath, authorizeReview: reviewAccess({ questionDelivery: { read: owns } }) });
    try {
      assert.deepEqual(readOnly.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts"), committed.final);
      assert.throws(() => readOnly.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), forbidden);
    } finally { readOnly.close(); }
    assert.throws(() => reopened.writeQuestionDeliveryVerdict({ ...reviewer, id: "outside-reviewer" }, activityId, key, command), forbidden);
    assert.throws(() => reopened.writeQuestionDeliveryVerdict(reviewer, activityId, { ...key, operationId: "unknown" }, command), forbidden);
    assert.throws(() => reopened.writeQuestionDeliveryVerdict(reviewer, activityId, key, { ...command, targetId: "unrelated-target" }), forbidden);
    allowed = false;
    assert.throws(() => reopened.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), forbidden);
    assert.throws(() => reopened.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts"), forbidden);
    assert.throws(() => reopened.recoverQuestionDelivery(outsider, activityId, key), forbidden);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 1, evaluation_tasks: 1,
      automatic_verdicts: 1, response_review_requirements: 1, performances: 2 });
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS n FROM verdict_events").get()?.n, 6);
    assert.equal(evaluated, 2);
  } finally { reopened.close(); }
});

test("题组教师改判｜人工题逐题按原确认授权，拒绝同组未交题和无评估作品", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("manual-verdict");
  let scopeSeen: unknown;
  const runtime = openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: reviewAccess({ questionDelivery: {
      read: scope => scope.reviewerId === reviewer.id && scope.studentId === student.id,
      write(scope) {
        scopeSeen = scope;
        return scope.reviewerId === reviewer.id && scope.studentId === student.id;
      },
    } }),
  });
  try {
    const individualStep = { ...step, submit: { ...step.submit, slots: { [slotId]: { ...step.submit.slots[slotId],
      delivery: { mode: "perQuestion", questionSlots: { [question.id]: "first", [optional.id]: "second" } } as const,
    } } } };
    runtime.publish({ practice: { ...base.practice, questions: [question, optional], steps: [individualStep], grading: { manualReview } },
      scoringKey: basis });
    const activity = start(runtime, base.practice.id);
    const draft = save(runtime, activity);
    const record = revision(question, draft.revision);
    const input: QuestionDeliveryInput = { ...confirmation(activity, [record]), source: "question", operationId: "confirm-first", questions: [record] };
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
    runtime.evaluatePending();
    const key = recoveryKey(input);
    const command = { protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId: question.id,
      operationId: "manual", action: "override", correct: true, reason: "原稿符合量表", expectedRevision: 0 } as const;
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, { ...command, questionId: optional.id }),
      { code: "FORBIDDEN" });
    const baseline = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
    assert.equal(baseline.assessment, "manual");
    assert.deepEqual(baseline.basis, basis);
    const first = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command);
    assert.equal(first.revision, 1);
    assert.deepEqual(scopeSeen, { reviewerId: reviewer.id, studentId: student.id, activityId: activity.activityId,
      stepAttemptId: activity.stepAttemptId, operationId: input.operationId, submissionId: receipt.id,
      slotId: "first", delivery: "questionDelivery", purpose: "reviseVerdict", targetId: "observe", questionId: question.id,
      questionVersion: question.version, action: "override" });
    const marked = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
    assert.deepEqual(marked.questions, [{ questionId: question.id, questionVersion: question.version, revision: 1,
      status: "judged", effective: { source: "teacherReview", id: first.id, correct: true } }]);
    assert.deepEqual(marked.confirmation, baseline.confirmation);
    const confirmed = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
    assert.equal(confirmed.assessment, "manual");
    const registered = [{ questionId: question.id, questionVersion: question.version, status: "needsReview" }];
    assert.deepEqual(confirmed.review.questions, registered);
    assert.deepEqual(runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key).questions, registered);
    using db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("SELECT status FROM evaluation_tasks WHERE submission_id = ?").get(receipt.id)?.status, "pending");
    assert.doesNotMatch(JSON.stringify(runtime.read(student, activity.activityId)), /teacherReview|原稿符合量表|private-reflection-rubric/);
    const draft2 = save(runtime, activity, optional, titleOnly);
    const other = revision(optional, draft2.revision);
    const finish = confirmation(activity, [record, other], "finish");
    const newReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, finish);
    runtime.evaluatePending();
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, { ...command, submissionId: newReceipt.id }),
      { code: "FORBIDDEN" });
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, recoveryKey(finish),
      { ...command, submissionId: newReceipt.id }), { code: "FORBIDDEN" });
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, recoveryKey(finish),
      { ...command, submissionId: newReceipt.id, questionId: optional.id }), { code: "OPERATION_CONFLICT" });
    assert.deepEqual(runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(finish), "verdicts").questions,
      [{ questionId: optional.id, questionVersion: optional.version, revision: 0, status: "needsReview" }]);
    db.prepare("INSERT INTO reading_reviews (activity_id, reviewer_id, reviewer_active) VALUES (?, ?, 0)").run(activity.activityId, reviewer.id);
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command), { code: "FORBIDDEN" });
    db.prepare("UPDATE reading_reviews SET reviewer_active = 1 WHERE activity_id = ?").run(activity.activityId);
    assert.deepEqual(runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command), first);
    const collection = publication("ungraded-verdict");
    runtime.publish(collection);
    const ungraded = start(runtime, collection.practice.id);
    const saved = save(runtime, ungraded);
    const confirmationInput = confirmation(ungraded, [revision(question, saved.revision)]);
    const ungradedReceipt = runtime.confirmQuestionDelivery(student, ungraded.activityId, confirmationInput);
    runtime.evaluatePending();
    const ungradedKey = recoveryKey(confirmationInput);
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, ungraded.activityId, ungradedKey, "verdicts"), { code: "REVIEW_NOT_FOUND" });
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, ungraded.activityId, ungradedKey,
      { ...command, submissionId: ungradedReceipt.id }), { code: "REVIEW_NOT_FOUND" });
    assert.deepEqual(facts(databasePath), { submissions: 3, completions: 2, scoring_keys: 1, evaluation_tasks: 2,
      automatic_verdicts: 0, response_review_requirements: 2, performances: 2 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM verdict_events").get()?.n, 1);
  } finally { runtime.close(); }
});

test("题组教师改判｜写入失败可重试，迟到初判不覆盖教师判定", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("late-automation");
  const runtime = openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: () => true,
    evaluators: [booleanEvaluator(evaluator, ({ value, acceptedResponse }) => ({ status: "judged", correct: value === acceptedResponse }))],
  });
  try {
    runtime.publish({ practice: { ...base.practice, questions: [judge], grading: automatic },
      scoringKey: { ...keyRef, acceptedByQuestion: { [judge.id]: { response: judge.response, acceptedResponse: false } } } });
    const activity = start(runtime, base.practice.id);
    const { activityId } = activity;
    const saved = save(runtime, activity, judge, false);
    const input = confirmation(activity, [revision(judge, saved.revision)]);
    const receipt = runtime.confirmQuestionDelivery(student, activityId, input);
    const key = recoveryKey(input);
    const command = { protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId: judge.id,
      operationId: "before-auto", action: "override", correct: false, reason: "复核原答", expectedRevision: 0 } as const;
    const read = () => runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts").questions[0];
    using db = new DatabaseSync(databasePath);
    db.exec(`CREATE TRIGGER abort_verdict BEFORE INSERT ON verdict_events BEGIN SELECT RAISE(ABORT, 'fixture verdict append failed'); END`);
    assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), /fixture verdict append failed/);
    assert.equal(read()?.revision, 0);
    assert.equal(read()?.status, "pendingEvaluation");
    db.exec("DROP TRIGGER abort_verdict");
    const marked = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, command);
    const teacher = { source: "teacherReview", id: marked.id, correct: false };
    const position = { questionId: judge.id, questionVersion: judge.version };
    assert.deepEqual(read(), { ...position, revision: 1, status: "judged", effective: teacher });
    runtime.evaluatePending();
    assert.equal(runtime.recoverQuestionDelivery(student, activityId, key).evaluation.correctCount, 1);
    assert.deepEqual(read(), { ...position, revision: 1, status: "judged", effective: teacher, automatic: { correct: true, valid: true } });
    assert.deepEqual(runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key, command), marked);
    const { correct: _correct, ...location } = command;
    runtime.writeQuestionDeliveryVerdict(reviewer, activityId, key,
      { ...location, action: "withdraw", operationId: "return-to-auto", expectedRevision: 1, withdrawId: marked.id });
    assert.deepEqual(read(), { ...position, revision: 2, status: "judged",
      effective: { source: "automatic", correct: true }, automatic: { correct: true, valid: true } });
  } finally { runtime.close(); }
});

const ordering = { id: "ordering", version: 5, prompt: "排列甲、乙，并提交原顺序。", response: "orderedTextBlanks", blankCount: 2 } as const;
const teacherReview = { questionIds: [ordering.id] };
const noReference = { ...ordering, id: "no-reference", blankCount: 0, prompt: "提交零个排序位置的原答。" };
const noReferenceMissing = { ...noReference, id: "no-reference-missing", version: 6 };
const judgeKey = { ...keyRef, acceptedByQuestion: { [judge.id]: { response: judge.response, acceptedResponse: true } } };

test("按题教师评阅｜混合回执只调用有私钥的评估器，无参考原答可先判后撤", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("declared-mixed-review");
  let canReview = true;
  let failEvaluation = true;
  const received: unknown[] = [];
  const runtime = openLearningRuntime({
    databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: reviewAccess({ questionDelivery: {
      read: scope => canReview && scope.studentId === student.id && scope.reviewerId === reviewer.id,
      write: scope => canReview && scope.studentId === student.id && scope.reviewerId === reviewer.id
        && scope.questionVersion === ordering.version && scope.slotId === slotId,
    } }),
    evaluators: [booleanEvaluator(evaluator, input => {
      received.push(input);
      if (failEvaluation) throw new Error("temporary evaluation failure");
      return { status: "judged", correct: input.value === input.acceptedResponse };
    })],
  });
  try {
    runtime.publish({ ...base, practice: { ...base.practice, questions: [judge, ordering], grading: { ...automatic, teacherReview } },
      scoringKey: judgeKey });
    const activity = start(runtime, base.practice.id);
    const answer = save(runtime, activity, judge, true);
    const blank = save(runtime, activity, ordering, []);
    const input = confirmation(activity, [revision(ordering, blank.revision), revision(judge, answer.revision)]);
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
    const key = recoveryKey(input);
    const read = () => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
    const submit = (command: Parameters<typeof runtime.writeQuestionDeliveryVerdict>[3]) =>
      runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command);
    const automaticPosition = { questionId: judge.id, questionVersion: judge.version, revision: 0 };
    const manualPosition = { questionId: ordering.id, questionVersion: ordering.version };
    const registered = [{ ...manualPosition, status: "needsReview" }];
    assert.deepEqual(read().questions, [{ ...automaticPosition, status: "pendingEvaluation" }, { ...registered[0], revision: 0 }]);
    assert.deepEqual(read().confirmation.questions.map(({ value }) => value), [true, []]);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 1, evaluation_tasks: 1,
      automatic_verdicts: 0, response_review_requirements: 1, performances: 1 });
    const correction = { protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId: ordering.id,
      operationId: "mark-ordering", action: "override", correct: false, reason: "已核实学生本次明确空交", expectedRevision: 0 } as const;
    assert.throws(() => submit({ ...correction, targetId: "wrong-target" }), { code: "FORBIDDEN" });
    assert.throws(() => submit({ ...correction, reason: "   " }), ZodError);
    const marked = submit(correction);
    assert.deepEqual(submit(correction), marked);
    assert.throws(() => submit({ ...correction, correct: true }), { code: "OPERATION_CONFLICT" });
    assert.deepEqual(runtime.evaluatePending(), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
    const interim = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
    assert.ok(interim.assessment === "automatic");
    assert.equal(interim.evaluation.status, "pending");
    assert.deepEqual(read().questions[1]?.status, "judged");
    failEvaluation = false;
    assert.deepEqual(runtime.evaluatePending(), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
    const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
    assert.equal(recovered.assessment, "automatic");
    assert.deepEqual(recovered.review?.questions, registered);
    const evaluation = { status: "evaluated", evaluator, questionCount: 1, correctCount: 1, needsReviewCount: 0, questions: [
      { questionId: judge.id, questionVersion: judge.version, result: { status: "judged", correct: true } },
    ] };
    assert.deepEqual(recovered.evaluation, evaluation);
    assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, key).evaluation, evaluation);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, input), receipt);
    assert.deepEqual(received, Array.from({ length: 2 }, () => ({
      activityId: activity.activityId, stepAttemptId: activity.stepAttemptId, slotId, practice: { id: base.practice.id, version: 1 },
      questionId: judge.id, questionVersion: judge.version, value: true, acceptedResponse: true,
    })));
    const { correct: _correct, ...location } = correction;
    submit({ ...location, action: "withdraw", operationId: "withdraw-ordering", withdrawId: marked.id, expectedRevision: 1 });
    assert.deepEqual(read().questions, [
      { ...automaticPosition, status: "judged", automatic: { correct: true, valid: true }, effective: { source: "automatic", correct: true } },
      { ...manualPosition, revision: 2, status: "needsReview" },
    ]);
    canReview = false;
    assert.throws(() => submit(correction), { code: "FORBIDDEN" });
    assert.throws(read, { code: "FORBIDDEN" });
    assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, key, "declared"), { code: "FORBIDDEN" });
    assert.doesNotMatch(JSON.stringify({ recovered, student: runtime.read(student, activity.activityId) }),
      /acceptedResponse|teacherReview|已核实学生|private-reflection-rubric/);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 1, evaluation_tasks: 1,
      automatic_verdicts: 1, response_review_requirements: 1, performances: 1 });
    using broken = new DatabaseSync(databasePath);
    broken.prepare("DELETE FROM response_review_requirements WHERE submission_id = ?").run(receipt.id);
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared"), /人工待评位置与冻结提交不一致/);
  } finally { runtime.close(); }
});

test("按题教师评阅｜无参考教师只读写声明题位，重开保留空答和判定", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("declared-teacher-only");
  let allowed = true;
  const settings = { databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: () => allowed };
  const runtime = openLearningRuntime(settings);
  const frozen = (() => {
    try {
      runtime.publish({ ...base, practice: { ...base.practice, questions: [ordering, optional], grading: { teacherReview } } });
      const activity = start(runtime, base.practice.id);
      const input = confirmation(activity, [revision(ordering, 0), revision(optional, 0)]);
      const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
      runtime.evaluatePending();
      const key = recoveryKey(input);
      const pending = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
      assert.equal(pending.assessment, "teacherReview");
      assert.equal(Object.hasOwn(pending, "basis"), false);
      assert.deepEqual(pending.questions, [{ questionId: ordering.id, questionVersion: ordering.version, revision: 0, status: "needsReview" }]);
      assert.deepEqual(pending.confirmation.questions.map(({ questionId, value }) => ({ questionId, value })), [{ questionId: ordering.id, value: null }]);
      assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key), { code: "REVIEW_NOT_FOUND" });
      const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
      assert.equal(recovered.assessment, "teacherReview");
      assert.deepEqual(recovered.confirmation.questions.map(({ questionId, value }) => ({ questionId, value })),
        [{ questionId: ordering.id, value: null }, { questionId: optional.id, value: null }]);
      assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, key), { code: "ASSESSMENT_MODE_MISMATCH" });
      const command = { protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId: ordering.id,
        operationId: "teacher-only", action: "override", correct: false, reason: "教师已核对冻结的空答", expectedRevision: 0 } as const;
      assert.throws(() => runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, { ...command, questionId: optional.id }),
        { code: "FORBIDDEN" });
      const marked = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command);
      return { activity, key, command, marked, recovered };
    } finally { runtime.close(); }
  })();
  const { activity, key, command, marked, recovered } = frozen;
  const reopened = openLearningRuntime(settings);
  try {
    assert.deepEqual(reopened.recoverQuestionDelivery(student, activity.activityId, key, "declared"), recovered);
    assert.deepEqual(reopened.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command), marked);
    const review = reopened.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
    assert.deepEqual(review.questions, [{ questionId: ordering.id, questionVersion: ordering.version, revision: 1,
      status: "judged", effective: { source: "teacherReview", id: marked.id, correct: false } }]);
    allowed = false;
    assert.throws(() => reopened.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, command), { code: "FORBIDDEN" });
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 0, evaluation_tasks: 0,
      automatic_verdicts: 0, response_review_requirements: 1, performances: 0 });
    using database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT count(*) AS n FROM evaluation_tasks").get()?.n, 0);
    const insertTask = database.prepare(`INSERT INTO evaluation_tasks (submission_id, key_id, key_version, target_id, status)
      VALUES (?, ?, ?, 'observe', 'done')`);
    assert.throws(() => insertTask.run(marked.submissionId, null, null), /NOT NULL constraint failed/);
    assert.throws(() => insertTask.run(marked.submissionId, "missing", 1), /FOREIGN KEY constraint failed/);
  } finally { reopened.close(); }
});

test("按题教师评阅｜旧库借空评估任务锚定的人工判定，升级后改挂原提交且读面不变", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("legacy-review-anchor");
  const settings = { databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: () => true };
  const before = (() => {
    const runtime = openLearningRuntime(settings);
    try {
      runtime.publish({ ...base, practice: { ...base.practice, questions: [ordering], grading: { teacherReview: { questionIds: [ordering.id] } } } });
      const activity = start(runtime, base.practice.id);
      const input = confirmation(activity, [revision(ordering, 0)]);
      const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
      runtime.evaluatePending();
      const key = recoveryKey(input);
      runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key, { protocolVersion: 1, submissionId: receipt.id,
        targetId: "observe", questionId: ordering.id, operationId: "legacy-mark", action: "override", correct: true,
        reason: "旧版人工判定", expectedRevision: 0 });
      return { activityId: activity.activityId, key, receipt, review: runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts") };
    } finally { runtime.close(); }
  })();
  {
    using legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false });
    legacy.exec(`
      BEGIN;
      CREATE TABLE legacy_tasks (
        submission_id TEXT PRIMARY KEY REFERENCES submissions (id), key_id TEXT, key_version INTEGER, target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'done')), CHECK ((key_id IS NULL) = (key_version IS NULL)),
        CHECK (key_id IS NOT NULL OR status = 'done'), FOREIGN KEY (key_id, key_version) REFERENCES scoring_keys (id, version)
      ) STRICT;
      INSERT INTO legacy_tasks SELECT submission_id, key_id, key_version, target_id, status FROM evaluation_tasks;
      DROP TABLE evaluation_tasks;
      ALTER TABLE legacy_tasks RENAME TO evaluation_tasks;
      INSERT INTO evaluation_tasks (submission_id, target_id, status) VALUES ('${before.receipt.id}', 'observe', 'done');
      CREATE TABLE legacy_requirements (
        submission_id TEXT NOT NULL REFERENCES evaluation_tasks (submission_id), question_id TEXT NOT NULL,
        PRIMARY KEY (submission_id, question_id)
      ) STRICT;
      INSERT INTO legacy_requirements SELECT * FROM response_review_requirements;
      DROP TABLE response_review_requirements;
      ALTER TABLE legacy_requirements RENAME TO response_review_requirements;
      CREATE TABLE legacy_events (
        id TEXT PRIMARY KEY, activity_id TEXT NOT NULL REFERENCES activities (id),
        submission_id TEXT NOT NULL REFERENCES evaluation_tasks (submission_id), target_id TEXT NOT NULL, question_id TEXT NOT NULL,
        revision INTEGER NOT NULL, reviewer_id TEXT NOT NULL, operation_id TEXT NOT NULL, reason TEXT NOT NULL, reviewed_at TEXT NOT NULL,
        action TEXT NOT NULL, correct INTEGER, withdraw_id TEXT REFERENCES legacy_events (id)
      ) STRICT;
      INSERT INTO legacy_events SELECT * FROM verdict_events;
      DROP TABLE verdict_events;
      ALTER TABLE legacy_events RENAME TO verdict_events;
      DROP TABLE self_assessment_events;
      DROP TABLE activity_restarts;
      DELETE FROM schema_migrations WHERE version >= ${reviewAnchorVersion};
      COMMIT;
    `);
    assert.deepEqual(legacy.prepare("PRAGMA foreign_key_check").all(), []);
  }
  const upgraded = openLearningRuntime(settings);
  try {
    assert.deepEqual(upgraded.readQuestionDeliveryReview(reviewer, before.activityId, before.key, "verdicts"), before.review);
  } finally { upgraded.close(); }
  using database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS n FROM evaluation_tasks").get()?.n, 0);
  for (const table of ["verdict_events", "response_review_requirements"]) {
    const parents = database.prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list('${table}') WHERE "from" = 'submission_id'`).all();
    assert.deepEqual(parents.map(row => row.parent), ["submissions"]);
  }
  assert.equal(database.prepare("SELECT count(*) AS n FROM verdict_events").get()?.n, 1);
});

test("按题教师评阅｜逐题仅为本次确认的声明位置建目标", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("declared-per-question");
  const runtime = openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: () => true });
  try {
    const individual = { ...step, submit: { ...step.submit, slots: { [slotId]: { ...step.submit.slots[slotId],
      delivery: { mode: "perQuestion", questionSlots: { [ordering.id]: "sort", [optional.id]: "collect" } } as const,
    } } } };
    runtime.publish({ ...base, practice: { ...base.practice, questions: [ordering, optional], steps: [individual], grading: { teacherReview } } });
    const activity = start(runtime, base.practice.id);
    const collected = revision(optional, 0);
    const input: QuestionDeliveryInput = { ...confirmation(activity, [collected]), source: "question", questions: [collected], operationId: "collect" };
    const collectedReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
    runtime.evaluatePending();
    const collectedKey = recoveryKey(input);
    assert.equal(collectedReceipt.slotId, "collect");
    assert.equal(runtime.recoverQuestionDelivery(student, activity.activityId, collectedKey, "declared").assessment, "none");
    assert.throws(() => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, collectedKey, "verdicts"), { code: "REVIEW_NOT_FOUND" });
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 0, scoring_keys: 0, evaluation_tasks: 0,
      automatic_verdicts: 0, response_review_requirements: 0, performances: 0 });
    const finish = confirmation(activity, [collected, revision(ordering, 0)], "finish");
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, finish);
    runtime.evaluatePending();
    const review = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, recoveryKey(finish), "verdicts");
    assert.deepEqual(review.receipt, receipt);
    assert.deepEqual(review.questions, [{ questionId: ordering.id, questionVersion: ordering.version, revision: 0, status: "needsReview" }]);
    assert.deepEqual(facts(databasePath), { submissions: 2, completions: 1, scoring_keys: 0, evaluation_tasks: 0,
      automatic_verdicts: 0, response_review_requirements: 1, performances: 0 });
  } finally { runtime.close(); }
});

test("按题教师评阅｜混合练法的单题回执按各自任务恢复", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("declared-separate-receipts");
  const inputs: unknown[] = [];
  const runtime = openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: () => true,
    evaluators: [booleanEvaluator(evaluator, input => {
      inputs.push(input);
      return { status: "needsReview" };
    })],
  });
  try {
    const individual = { ...step, submit: { ...step.submit, slots: { [slotId]: { ...step.submit.slots[slotId],
      delivery: { mode: "perQuestion", questionSlots: { [ordering.id]: "sort", [judge.id]: "auto" } } as const,
    } } } };
    runtime.publish({ ...base, practice: { ...base.practice, questions: [ordering, judge], steps: [individual], grading: { ...automatic, teacherReview } },
      scoringKey: judgeKey });
    const activity = start(runtime, base.practice.id);
    const request: QuestionDeliveryInput = { ...confirmation(activity, [revision(ordering, 0)]),
      source: "question", questions: [revision(ordering, 0)], operationId: "sort" };
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, request);
    runtime.evaluatePending();
    const key = recoveryKey(request);
    assert.equal(receipt.slotId, "sort");
    assert.equal(runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared").assessment, "teacherReview");
    assert.throws(() => runtime.recoverQuestionDelivery(student, activity.activityId, key), { code: "ASSESSMENT_MODE_MISMATCH" });
    assert.deepEqual(inputs, []);
    const finished = confirmation(activity, [revision(ordering, 0), revision(judge, 0)], "finish");
    const finishReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, finished);
    runtime.evaluatePending();
    const result = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(finished), "declared");
    assert.equal(result.assessment, "automatic");
    assert.equal(result.review, undefined);
    assert.deepEqual(result.evaluation.questions, [{ questionId: judge.id, questionVersion: judge.version, result: { status: "needsReview" } }]);
    assert.equal(inputs.length, 1);
    assert.equal(result.confirmation.questions.length, 1);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT 1 FROM evaluation_tasks WHERE submission_id = ?").get(receipt.id), undefined);
    assert.ok(database.prepare("SELECT 1 FROM response_review_requirements WHERE submission_id = ?").get(receipt.id));
    const task = database.prepare("SELECT key_id, key_version, status FROM evaluation_tasks WHERE submission_id = ?");
    assert.deepEqual({ ...task.get(finishReceipt.id) }, { key_id: keyRef.id, key_version: keyRef.version, status: "done" });
  } finally { runtime.close(); }
});

test("按题教师评阅｜发布拒绝占位键、未绑定题位、重复、旧人工方式及无自动题的自动声明", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath, evaluators: [booleanEvaluator(evaluator, () => ({ status: "needsReview" }))] });
  const { practice } = publication("declared-invalid");
  const questions = [judge, ordering];
  try {
    const publish = (grading: typeof automatic | { teacherReview: { questionIds: string[] } }, scoringKey?: typeof judgeKey) =>
      runtime.publish({ practice: { ...practice, questions, grading }, ...scoringKey && { scoringKey } });
    assert.throws(() => publish({ teacherReview: { questionIds: [] } }), ZodError);
    assert.throws(() => publish({ teacherReview: { questionIds: [ordering.id, ordering.id] } }), /评阅题标识重复/);
    assert.throws(() => publish({ teacherReview: { questionIds: ["unknown"] } }), /教师评阅须绑定已发布的题/);
    const grading = { ...automatic, teacherReview };
    assert.throws(() => runtime.publish({ practice: { ...practice, questions, grading }, scoringKey: { ...judgeKey, acceptedByQuestion: {
      ...judgeKey.acceptedByQuestion, [ordering.id]: { response: ordering.response, acceptedBlanks: [[], []] },
    } } }), /教师评阅题不得提供自动评分键/);
    assert.throws(() => publish({ teacherReview }, judgeKey), /冻结的评分依据须有对应的评估声明/);
    assert.throws(() => runtime.publish({ practice: { ...practice, questions, grading: { teacherReview, manualReview } }, scoringKey: basis }),
      /教师评阅与整组人工评阅不能同时声明/);
    assert.throws(() => runtime.publish({ practice: { ...practice, questions: [ordering], grading }, scoringKey: judgeKey }),
      /自动评估须绑定至少一道题/);
    const { response: _response, ...missingFormat } = judge;
    assert.throws(() => runtime.publish({ practice: { ...practice, questions: [missingFormat], grading: {
      teacherReview: { questionIds: [missingFormat.id] },
    } } }), /逐题交付须声明题的原值形态/);
    const singleChoice = { ...step, tool: { id: "single-choice-group", version: 1 },
      submit: { ...step.submit, slots: { [slotId]: { type: "oneChoicePerQuestion", source: "questions", targetId: "observe" } } },
    } as const;
    assert.throws(() => runtime.publish({ practice: { ...practice, questions: [missingFormat], steps: [singleChoice], grading: {
      teacherReview: { questionIds: [missingFormat.id] },
    } } }), /教师评阅须绑定题组交付槽/);
    assert.throws(() => start(runtime, practice.id), { code: "PRACTICE_NOT_FOUND" });
  } finally { runtime.close(); }
});

test("零位置有序答案｜同一确认保留显式空答与缺稿，重开后按权限评阅和重放", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("zero-ordered-teacher-review");
  let allowed = true;
  const settings = { databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    authorizeReview: reviewAccess({ questionDelivery: { read: ({ reviewerId }) => reviewerId === reviewer.id,
      write: ({ reviewerId }) => allowed && reviewerId === reviewer.id } }) };
  const first = openLearningRuntime(settings);
  const { activity, input, receipt } = (() => {
    try {
      const questions = [noReference, noReferenceMissing];
      first.publish({ ...base, practice: { ...base.practice, questions,
        grading: { teacherReview: { questionIds: questions.map(({ id }) => id) } } } });
      const activity = start(first, base.practice.id);
      const view = first.read(student, activity.activityId);
      assert.ok("inputs" in view && view.inputs.questions?.from === "questions");
      assert.deepEqual(view.inputs.questions.questions, questions.map(question => ({ ...question, options: {} })));
      const draft = save(first, activity, noReference, []);
      assert.equal(draft.revision, 1);
      assert.deepEqual(save(first, activity, noReference, []), draft);
      const input = confirmation(activity, [revision(noReference, 1), revision(noReferenceMissing, 0)]);
      const receipt = first.confirmQuestionDelivery(student, activity.activityId, input);
      first.evaluatePending();
      return { activity, input, receipt };
    } finally { first.close(); }
  })();
  const runtime = openLearningRuntime(settings);
  try {
    const key = recoveryKey(input);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, input), receipt);
    const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared");
    assert.equal(recovered.assessment, "teacherReview");
    assert.equal(Object.hasOwn(recovered, "evaluation"), false);
    assert.deepEqual(recovered.confirmation.questions, [
      { ...input.questions[0], value: [] }, { ...input.questions[1], value: null },
    ]);
    const read = () => runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
    const pending = read();
    assert.deepEqual(pending.confirmation, recovered.confirmation);
    assert.deepEqual(pending.questions, [noReference, noReferenceMissing].map(({ id, version }) => ({
      questionId: id, questionVersion: version, revision: 0, status: "needsReview",
    })));
    const other = { ...reviewer, id: "other-reviewer" };
    const write = (command: Parameters<Runtime["writeQuestionDeliveryVerdict"]>[3], principal: typeof other = reviewer) =>
      runtime.writeQuestionDeliveryVerdict(principal, activity.activityId, key, command);
    assert.throws(() => runtime.readQuestionDeliveryReview(other, activity.activityId, key, "verdicts"), { code: "FORBIDDEN" });
    const mark = { protocolVersion: 1, submissionId: receipt.id, targetId: "observe", questionId: noReference.id,
      operationId: "mark", action: "override", correct: false, reason: "已核对显式空答。", expectedRevision: 0 } as const;
    assert.throws(() => write(mark, other), { code: "FORBIDDEN" });
    const marked = write(mark);
    assert.deepEqual(write(mark), marked);
    assert.deepEqual(read().questions[0], { ...pending.questions[0], revision: 1, status: "judged",
      effective: { source: "teacherReview", id: marked.id, correct: false } });
    const { correct: _correct, ...position } = mark;
    const withdraw = { ...position, operationId: "withdraw", action: "withdraw", withdrawId: marked.id, expectedRevision: 1 } as const;
    assert.throws(() => write(withdraw, other), { code: "FORBIDDEN" });
    const withdrawn = write(withdraw);
    assert.deepEqual(write(withdraw), withdrawn);
    assert.deepEqual(read().questions, [{ ...pending.questions[0], revision: 2 }, pending.questions[1]]);
    allowed = false;
    assert.throws(() => write(mark), { code: "FORBIDDEN" });
    assert.throws(() => write(withdraw), { code: "FORBIDDEN" });
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, scoring_keys: 0, evaluation_tasks: 0,
      automatic_verdicts: 0, response_review_requirements: 2, performances: 0 });
    using database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT count(*) AS n FROM evaluation_tasks").get()?.n, 0);
  } finally { runtime.close(); }
});

test("零位置有序答案｜混合题组仅把非零位置题及真实键交给评估器", t => {
  const databasePath = scenarioDatabase(t);
  const base = publication("zero-ordered-mixed");
  const acceptedBlanks = [["甲"], ["乙"]];
  const value = ["甲", "乙"];
  const observed: unknown[] = [];
  const runtime = openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true,
    evaluators: [orderedTextEvaluator(evaluator, input => {
      observed.push([input.questionId, input.questionVersion, input.value, input.acceptedBlanks]);
      return { status: "judged", correct: input.value?.length === input.acceptedBlanks.length
        && input.acceptedBlanks.every((candidates, index) => candidates.some(candidate => candidate === input.value?.[index])) };
    })],
  });
  try {
    runtime.publish({ ...base, practice: { ...base.practice, questions: [noReference, ordering],
      grading: { ...automatic, teacherReview: { questionIds: [noReference.id] } } },
    scoringKey: { ...keyRef, acceptedByQuestion: { [ordering.id]: { response: ordering.response, acceptedBlanks } } } });
    const activity = start(runtime, base.practice.id);
    assert.equal(save(runtime, activity, ordering, value).revision, 1);
    const input = confirmation(activity, [revision(noReference, 0), revision(ordering, 1)]);
    runtime.confirmQuestionDelivery(student, activity.activityId, input);
    runtime.evaluatePending();
    const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(input), "declared");
    assert.equal(recovered.assessment, "automatic");
    assert.equal(recovered.evaluation.questionCount, 1);
    assert.equal(recovered.evaluation.correctCount, 1);
    assert.deepEqual(recovered.review?.questions, [{
      questionId: noReference.id, questionVersion: noReference.version, status: "needsReview",
    }]);
    assert.deepEqual(observed, [[ordering.id, ordering.version, value, acceptedBlanks]]);
    assert.doesNotMatch(JSON.stringify({ recovered, view: runtime.read(student, activity.activityId) }), /acceptedByQuestion|acceptedBlanks/);
  } finally { runtime.close(); }
});

test("零位置有序答案｜保留自动评估的真实键及正位置约束", t => {
  const databasePath = scenarioDatabase(t);
  const { practice } = publication("zero-ordered-invalid");
  const runtime = openLearningRuntime({ databasePath,
    evaluators: [orderedTextEvaluator(evaluator, () => ({ status: "needsReview" }))],
  });
  try {
    const input = { practice: { ...practice, questions: [noReference], grading: automatic } };
    const publishWith = (acceptedByQuestion: Record<string, { response: "orderedTextBlanks"; acceptedBlanks: string[][] }>) =>
      runtime.publish({ ...input, scoringKey: { ...keyRef, acceptedByQuestion } });
    assert.throws(() => runtime.publish(input), /逐题交付须提供按题冻结的评分键/);
    assert.throws(() => publishWith({}), /私有键须匹配本题的冻结形态、选项或空位/);
    assert.throws(() => publishWith({ [noReference.id]: { response: noReference.response, acceptedBlanks: [] } }), ZodError);
    assert.throws(() => publishWith({ [noReference.id]: { response: noReference.response, acceptedBlanks: [[]] } }),
      /私有键须匹配本题的冻结形态、选项或空位/);
    for (const blankCount of [-1, 0.5]) {
      assert.throws(() => runtime.publish({ practice: { ...practice, questions: [{ ...noReference, blankCount }],
        grading: { teacherReview: { questionIds: [noReference.id] } } } }), ZodError);
    }
    assert.throws(() => start(runtime, practice.id), { code: "PRACTICE_NOT_FOUND" });
  } finally { runtime.close(); }
});
