import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { openLearningRuntime } from "../src/server.ts";
import type { PublicationInput, QuestionDeliveryInput, ResponseValue, TitledTextResponseValue } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "rule-student" } as const;
const outsider = { ...student, id: "rule-outsider" };
const evaluator = { id: "fixture-evaluator", version: 1 };
const judge = { id: "judgment", version: 1, prompt: "判断第一条观察。", response: "booleanOrString", options: { yes: "对", no: "错" } } as const;
const written = { id: "writing", version: 2, prompt: "写下观察。", response: "textWithOptionalTitle" } as const;
const scalarRule = { id: "private-scalar-rule", version: 1 };
const titleRule = { id: "private-title-rule", version: 1 };
const slotId = "answers";

type Runtime = ReturnType<typeof openLearningRuntime>;
type Activity = ReturnType<Runtime["start"]>;
type Question = { id: string } & (Omit<typeof judge, "id"> | Omit<typeof written, "id">);
type Answer = ResponseValue | TitledTextResponseValue;
type RuleRef = typeof scalarRule;

function publication(
  id: string, { version = 1, allowUnanswered = false, questions = [judge], questionAnswerRules }:
  { version?: number; allowUnanswered?: boolean; questions?: Question[]; questionAnswerRules?: Record<string, RuleRef> } = {},
) {
  const keyRef = { id: id + "-key", version };
  return {
    practice: {
      id, version, formatVersion: 1, title: "独立合成的作答规则",
      ...(questionAnswerRules && { questionAnswerRules }),
      goals: { answer: "保存和确认观察" }, questions,
      steps: [{
        id: "answer", instructions: "保存并确认。", tool: { id: "question-delivery", version: 1 },
        inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { [slotId]: {
          type: "questionDelivery", source: "questions", targetId: "answer", confirmFromDrafts: { allowUnanswered },
          delivery: { mode: "whole" },
        } } },
        afterConfirmation: "finish",
      }],
      grading: { assessment: {
        from: { stepId: "answer", slotId }, evaluator, keyRef, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
      } },
      policy: {
        offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
      },
    },
    scoringKey: { ...keyRef, acceptedByQuestion: Object.fromEntries(questions.map(question =>
      [question.id, question.response === "booleanOrString"
        ? { response: question.response, acceptedResponse: false }
        : { response: question.response }])),
    },
  } satisfies PublicationInput;
}

function baseSettings(databasePath: string, canRecover = () => true) {
  return {
    databasePath, authorizeConfirmationRecovery: canRecover,
    responseEvaluators: [{ ...evaluator, evaluate: () => ({ status: "needsReview" as const }) }],
    titledTextEvaluators: [{ ...evaluator, evaluate: () => ({ status: "needsReview" as const }) }],
  };
}

function open(runtime: Runtime, practiceId: string, operationId: string, practiceVersion = 1) {
  return runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion, operationId });
}

function save(runtime: Runtime, activity: Activity, value: Answer, question: Question = judge, baseRevision = 0) {
  return runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion: question.version,
    operationId: `save-${baseRevision}`, baseRevision, value,
  });
}

function request(activity: Activity, entries: readonly [Question, number][]) {
  return {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, operationId: "confirm", source: "whole",
    questions: entries.map(([question, revision]) => ({ questionId: question.id, questionVersion: question.version,
      revision, original: { state: "uncollected" },
    } as const)),
  } as const;
}

function recoveryKey({ protocolVersion, stepAttemptId, operationId }: ReturnType<typeof request>) {
  return { protocolVersion, stepAttemptId, operationId };
}

function facts(path: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return Object.fromEntries(["submissions", "completions", "evaluation_tasks", "performances"].map(table =>
    [table, db.prepare("SELECT count(*) AS n FROM " + table).get()?.n]));
}

function viewOf(runtime: Runtime, activity: Activity) {
  const view = runtime.read(student, activity.activityId);
  assert.ok("questionDeliveryDrafts" in view);
  return view;
}

test("旧题组没有冻结规则时，两个空格和 false 均沿用原回执与表现语义", t => {
  const databasePath = scenarioDatabase(t);
  const runtime = openLearningRuntime(baseSettings(databasePath));
  try {
    const published = publication("original-scalar");
    runtime.publish(published);
    for (const [operationId, value] of [["two-spaces", "  "], ["explicit-false", false]] as const) {
      const activity = open(runtime, published.practice.id, operationId);
      const draft = save(runtime, activity, value);
      const confirmation = request(activity, [[judge, draft.revision]]);
      const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, confirmation);
      assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, confirmation), receipt);
      const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, recoveryKey(confirmation));
      assert.deepEqual(recovered.confirmation.questions.map(item => item.value), [value]);
      assert.equal(recovered.evaluation.needsReviewCount, 1);
    }
    assert.deepEqual(facts(databasePath), { submissions: 2, completions: 2, evaluation_tasks: 2, performances: 2 });
  } finally { runtime.close(); }
});

test("冻结标量已答规则拒绝两个空格，false 确认一次并登记一次表现", t => {
  const databasePath = scenarioDatabase(t);
  const observed: ResponseValue[] = [];
  const runtime = openLearningRuntime({
    ...baseSettings(databasePath),
    questionAnswerRules: [{ ...scalarRule, response: "booleanOrString", isAnswered(value: ResponseValue) {
      observed.push(value);
      return typeof value === "boolean" || value.trim() !== "";
    } }],
  });
  try {
    const published = publication("rule-scalar", { questionAnswerRules: { [judge.id]: scalarRule } });
    runtime.publish(published);
    const activity = open(runtime, published.practice.id, "op");
    const empty = save(runtime, activity, "  ");
    const initial = request(activity, [[judge, empty.revision]]);
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, initial),
      { status: 422, code: "UNANSWERED_QUESTION" });
    assert.deepEqual(viewOf(runtime, activity).questionDeliveryDrafts, [empty]);
    assert.deepEqual(facts(databasePath), { submissions: 0, completions: 0, evaluation_tasks: 0, performances: 0 });
    const next = save(runtime, activity, false, judge, empty.revision);
    const accepted = request(activity, [[judge, next.revision]]);
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, accepted);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, accepted), receipt);
    assert.deepEqual(observed, ["  ", false]);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, evaluation_tasks: 1, performances: 1 });
  } finally { runtime.close(); }
});

test("允许空答时标题原样冻结，只有正文登记表现，回取与撤权均不重算规则", t => {
  const databasePath = scenarioDatabase(t);
  const observed: Readonly<TitledTextResponseValue>[] = [];
  const observedScalar: ResponseValue[] = [];
  const recorded = { body: " \t\n\u3000", title: "  只写标题  " };
  const completed = { body: "  第一段\n\n第二段  ", title: "" };
  const extra = { ...written, id: "extra-writing" };
  const missed = { ...written, id: "missing-writing" };
  const published = publication("ruled-writing", { allowUnanswered: true, questions: [written, extra, missed, judge],
    questionAnswerRules: { [written.id]: titleRule, [extra.id]: titleRule, [missed.id]: titleRule, [judge.id]: scalarRule },
  });
  const config = baseSettings(databasePath);
  const runtime = openLearningRuntime({
    ...config, questionAnswerRules: [{ ...titleRule, response: "textWithOptionalTitle",
      isAnswered(value: Readonly<TitledTextResponseValue>) {
        observed.push(value);
        return value.body.trim() !== "";
      },
    }, { ...scalarRule, response: "booleanOrString", isAnswered(value: ResponseValue) {
      observedScalar.push(value);
      return typeof value === "boolean" || value.trim() !== "";
    } }],
  });
  let activity: Activity;
  let confirmation: ReturnType<typeof request>;
  let receipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  try {
    runtime.publish(published);
    runtime.publish({ ...published, practice: { ...published.practice, questionAnswerRules: {
      [judge.id]: scalarRule, [missed.id]: titleRule, [extra.id]: titleRule, [written.id]: titleRule,
    } } });
    activity = open(runtime, published.practice.id, "op");
    const onlyTitle = save(runtime, activity, recorded, written);
    const withBody = save(runtime, activity, completed, extra);
    const onlySpaces = save(runtime, activity, "  ");
    assert.deepEqual(viewOf(runtime, activity).questionDeliveryDrafts, [withBody, onlySpaces, onlyTitle]);
    assert.doesNotMatch(JSON.stringify(viewOf(runtime, activity)), /questionAnswerRules|private-title-rule|isAnswered/);
    confirmation = request(activity, [[written, onlyTitle.revision], [extra, withBody.revision], [missed, 0], [judge, onlySpaces.revision]]);
    const claimed = { ...confirmation, questions: confirmation.questions.map(question => ({ ...question, answered: true })) };
    assert.throws(() => Reflect.apply(runtime.confirmQuestionDelivery, runtime, [student, activity.activityId, claimed]), ZodError);
    assert.deepEqual(observed, []);
    receipt = runtime.confirmQuestionDelivery(student, activity.activityId, confirmation);
    assert.deepEqual(observed, [recorded, completed]);
    assert.deepEqual(observedScalar, ["  "]);
    assert.deepEqual(facts(databasePath), { submissions: 1, completions: 1, evaluation_tasks: 1, performances: 1 });
  } finally { runtime.close(); }

  let authorized = true;
  const reopened = openLearningRuntime({ ...config, authorizeConfirmationRecovery: () => authorized });
  try {
    const key = recoveryKey(confirmation);
    assert.deepEqual(reopened.confirmQuestionDelivery(student, activity.activityId, confirmation), receipt);
    assert.throws(() => reopened.recoverQuestionDelivery(outsider, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    const recovered = reopened.recoverQuestionDelivery(student, activity.activityId, key);
    assert.deepEqual(recovered.receipt, receipt);
    assert.deepEqual(recovered.confirmation.questions.map(question => [question.revision, question.value]),
      [[1, recorded], [1, completed], [0, null], [1, "  "]]);
    assert.deepEqual(viewOf(reopened, activity).questionDeliveries, [{ receipt, questionDelivery: recovered.confirmation }]);
    assert.doesNotMatch(JSON.stringify(viewOf(reopened, activity)), /questionAnswerRules|private-title-rule|needsReview|"answered"/);
    authorized = false;
    assert.throws(() => reopened.confirmQuestionDelivery(student, activity.activityId, confirmation), { status: 403, code: "FORBIDDEN" });
    assert.throws(() => reopened.recoverQuestionDelivery(student, activity.activityId, key), { status: 403, code: "FORBIDDEN" });
    assert.deepEqual(observed, [recorded, completed]);
    assert.deepEqual(observedScalar, ["  "]);
    using db = new DatabaseSync(databasePath, { readOnly: true });
    const performances = db.prepare("SELECT unit_id AS unit FROM performances").all().map(row => row.unit);
    assert.deepEqual(performances, ["question:" + extra.id]);
  } finally { reopened.close(); }
});

test("规则以冻结发布版本为准，缺失注册、错形态或异常结果关闭确认", t => {
  const databasePath = scenarioDatabase(t);
  const scalarV2 = { ...scalarRule, version: 2 };
  const visits: number[] = [];
  const placeholder = "  合成占位词  ";
  const registrations = [
    { ...scalarRule, response: "booleanOrString", isAnswered: () => { visits.push(1); return true; } },
    { ...scalarV2, response: "booleanOrString", isAnswered: value => { visits.push(2); return value !== placeholder; } },
  ] satisfies NonNullable<Parameters<typeof openLearningRuntime>[0]["questionAnswerRules"]>;
  const config = baseSettings(databasePath);
  const runtime = openLearningRuntime({ ...config, questionAnswerRules: registrations });
  let current: Activity;
  let input: ReturnType<typeof request>;
  try {
    const first = publication("rule-version", { questionAnswerRules: { [judge.id]: scalarRule } });
    const second = publication("rule-version", { version: 2, questionAnswerRules: { [judge.id]: scalarV2 } });
    runtime.publish(first);
    assert.throws(() => runtime.publish({ ...first, practice: { ...first.practice,
      questionAnswerRules: { [judge.id]: scalarV2 },
    } }), /不能更改/);
    const original = open(runtime, first.practice.id, "v1");
    runtime.publish(second);
    current = open(runtime, second.practice.id, "v2", 2);
    const stated = save(runtime, current, placeholder);
    const oldDraft = save(runtime, original, placeholder);
    input = request(current, [[judge, stated.revision]]);
    const oldReceipt = request(original, [[judge, oldDraft.revision]]);
    assert.throws(() => runtime.confirmQuestionDelivery(student, current.activityId, input),
      { code: "UNANSWERED_QUESTION" });
    assert.ok(runtime.confirmQuestionDelivery(student, original.activityId, oldReceipt).id);
    assert.deepEqual(visits, [2, 1]);
    assert.deepEqual(viewOf(runtime, current).questionDeliveryDrafts, [stated]);
  } finally { runtime.close(); }

  const expected = { submissions: 1, completions: 1, evaluation_tasks: 1, performances: 1 };
  for (const questionAnswerRules of [[], registrations.slice(0, 1),
    [{ ...scalarV2, response: "textWithOptionalTitle", isAnswered: () => true }] as const,
  ]) {
    const reopened = openLearningRuntime({ ...config, questionAnswerRules: [...questionAnswerRules] });
    try {
      assert.throws(() => reopened.confirmQuestionDelivery(student, current.activityId, input), { status: 503, code: "ANSWER_RULE_UNAVAILABLE" });
      assert.equal(viewOf(reopened, current).status, "active");
      assert.deepEqual(facts(databasePath), expected);
    } finally { reopened.close(); }
  }
  const malformed = Reflect.apply(openLearningRuntime, undefined, [{
    ...config, questionAnswerRules: [{ ...scalarV2, response: "booleanOrString", isAnswered: () => "truthy" }],
  }]) as Runtime;
  try {
    assert.throws(() => malformed.confirmQuestionDelivery(student, current.activityId, input), ZodError);
    assert.deepEqual(facts(databasePath), expected);
    assert.deepEqual(viewOf(malformed, current).questionDeliveryDrafts?.map(({ value }) => value), [placeholder]);
    assert.deepEqual(visits, [2, 1]);
  } finally { malformed.close(); }
});

test("发布只绑定已冻结题和精确形态，拒绝未注册规则与纯作答槽", t => {
  const databasePath = scenarioDatabase(t);
  const config = baseSettings(databasePath);
  const scalar = { ...scalarRule, response: "booleanOrString" as const, isAnswered: () => true };
  const writtenRule = { ...titleRule, response: "textWithOptionalTitle" as const, isAnswered: () => true };
  assert.throws(() => openLearningRuntime({ ...config, questionAnswerRules: [scalar, scalar] }), ZodError);
  const runtime = openLearningRuntime({ ...config, questionAnswerRules: [scalar, writtenRule] });
  try {
    const good = publication("bound-judgment", { questionAnswerRules: { [judge.id]: scalarRule } });
    const step = good.practice.steps[0];
    const plain = { practice: { ...good.practice, id: "plain-scalar", questions: [{ id: judge.id, version: judge.version,
      prompt: judge.prompt, options: judge.options,
    }], steps: [{ ...step, tool: { id: "response-group", version: 1 },
      submit: { purpose: "finalAnswer", slots: { [slotId]: { type: "oneResponsePerQuestion", input: "booleanOrString",
        source: "questions", targetId: "answer", confirmFromDrafts: { allowUnanswered: false },
      } } } }],
    }, scoringKey: { id: good.scoringKey.id, version: good.scoringKey.version, acceptedResponses: { [judge.id]: false } } };
    for (const [candidate, path] of [
      [publication("unknown-question", { questionAnswerRules: { absent: scalarRule } }), "practice.questionAnswerRules.absent"],
      [publication("wrong-rule-version", { questionAnswerRules: { [judge.id]: { ...scalarRule, version: 7 } } }), "practice.questionAnswerRules.judgment"],
      [publication("wrong-rule-shape", { questionAnswerRules: { [judge.id]: titleRule } }), "practice.questionAnswerRules.judgment"],
      [plain, "practice.questionAnswerRules"],
    ] as const) {
      assert.throws(() => Reflect.apply(runtime.publish, runtime, [candidate]), (error: unknown) =>
        error instanceof ZodError && error.issues.some(issue => issue.path.join(".") === path));
      assert.throws(() => open(runtime, candidate.practice.id, "rejected"), { code: "PRACTICE_NOT_FOUND" });
    }
    using db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM practices").get()?.n, 0);
  } finally { runtime.close(); }
});

test("逐题确认和收尾只计算本次交付，忽略此前已确认的规则", t => {
  const databasePath = scenarioDatabase(t);
  const observed: string[] = [];
  const runtime = openLearningRuntime({ ...baseSettings(databasePath), questionAnswerRules: [
    { ...scalarRule, response: "booleanOrString", isAnswered: () => { observed.push(judge.id); return true; } },
    { ...titleRule, response: "textWithOptionalTitle", isAnswered: ({ body }) => {
      observed.push(written.id);
      return body.trim() !== "";
    } },
  ] });
  try {
    const group = publication("rule-per-question", { allowUnanswered: true, questions: [judge, written],
      questionAnswerRules: { [judge.id]: scalarRule, [written.id]: titleRule },
    });
    const step = group.practice.steps[0];
    const answers = step.submit.slots[slotId];
    runtime.publish({ ...group, practice: { ...group.practice, steps: [{
      ...step, submit: { ...step.submit, slots: { [slotId]: { ...answers, delivery: {
        mode: "perQuestion", questionSlots: { [judge.id]: "position-judgment", [written.id]: "position-writing" },
      } } } },
    }] } });
    const activity = open(runtime, group.practice.id, "op");
    const first = save(runtime, activity, false);
    const second = save(runtime, activity, { body: "", title: "只写标题" }, written);
    const all = request(activity, [[judge, first.revision], [written, second.revision]]);
    const [question] = all.questions;
    assert.ok(question);
    const firstIntent = { ...all, source: "question", operationId: "early", questions: [question] } satisfies QuestionDeliveryInput;
    const firstReceipt = runtime.confirmQuestionDelivery(student, activity.activityId, firstIntent);
    assert.equal(firstReceipt.slotId, "position-judgment");
    assert.equal(viewOf(runtime, activity).status, "active");
    assert.deepEqual(observed, [judge.id]);
    const finish = { ...all, source: "finish" as const };
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, finish);
    assert.deepEqual(runtime.confirmQuestionDelivery(student, activity.activityId, finish), receipt);
    assert.deepEqual(observed, [judge.id, written.id]);
    assert.deepEqual(facts(databasePath), { submissions: 2, completions: 1, evaluation_tasks: 2, performances: 1 });
  } finally { runtime.close(); }
});
