import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { EvaluatorRegistration, SelfAssessmentInput } from "../src/server.ts";
import {
  contractPolicy, deliveryInput, deliveryPublication, evaluatorRef, openRuntime, outsider, override, recoveryKey, reviewer, saveDraft, startFor,
  student, withdraw,
} from "./fixtures/contracts/delivery.ts";
import type { Activity, DeliveryDeclaration, Runtime } from "./fixtures/contracts/delivery.ts";
import { pendingToken, stubKeyFor, stubQuestion, stubResponse } from "./fixtures/contracts/scenario-contract.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

type Scoring = "separate" | "countAsCorrect";
type Key = ReturnType<typeof recoveryKey>;
type Policy = NonNullable<DeliveryDeclaration["policy"]>;

const objective = stubQuestion("q1");
const essay = stubQuestion("q2");
const reflection = stubQuestion("q3");
const questions = [objective, essay, reflection] as const;
const passageScore = {
  whenAll: ["finalConfirmed", "allQuestionsJudged"], group: "wholePassage", fields: ["correctCount", "questionCount"],
  allowSubsets: false, drilldown: false,
} satisfies NonNullable<Policy["student"]["passageScore"]>;
const evaluator: EvaluatorRegistration = {
  ...evaluatorRef, responseTypes: [stubResponse.id],
  evaluate: ({ value, key }) => value === pendingToken ? { status: "needsReview" } : { status: "judged", correct: value === Reflect.get(Object(key), "acceptedToken") },
};

function policy(scoring?: Scoring, scored = true): Policy {
  return {
    ...contractPolicy,
    student: {
      ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt"], onFinal: ["passageGradingStatus"] },
      ...scored && { passageScore }, ...scoring && { selfAssessment: { scoring } },
    },
  };
}

function declaration(id: string, scoring: Scoring | undefined, mode: "whole" | "perQuestion" = "whole"): DeliveryDeclaration {
  return {
    id, questions, mode, allowUnanswered: true, policy: policy(scoring),
    grading: {
      keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙"), q3: stubKeyFor("丙") }, teacherReview: [],
      ...scoring && { selfReview: [essay.id, reflection.id] },
    },
  };
}

function open(t: TestContext) {
  const runtime = openRuntime(scenarioDatabase(t), { responseTypes: [stubResponse], evaluators: [evaluator], authorizeReview: () => true });
  t.after(() => runtime.close());
  return runtime;
}

function handInWhole(runtime: Runtime, id: string, scoring: Scoring | undefined) {
  runtime.publish(deliveryPublication(declaration(id, scoring)));
  const activity = startFor(runtime, id);
  const handed = questions.map((question, index) => ({
    question, revision: saveDraft(runtime, activity, question, index === 0 ? "甲" : pendingToken).revision,
  }));
  const input = deliveryInput(activity, "whole", handed, "hand-in");
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  runtime.evaluatePending();
  return { activity, key: recoveryKey(input), receipt };
}

function command(questionId: string, operationId: string, expectedRevision: number, verdict: SelfAssessmentInput["verdict"],
  rubric?: SelfAssessmentInput["rubric"]): SelfAssessmentInput {
  return { protocolVersion: 1, operationId, questionId, expectedRevision, verdict, ...rubric && { rubric } };
}

function counts(runtime: Runtime, activity: Activity, key: Key) {
  const { selfAssessment } = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts");
  assert.ok(selfAssessment && "correctCount" in selfAssessment);
  return selfAssessment;
}

for (const [scoring, correctCount] of [["separate", 1], ["countAsCorrect", 2]] as const) {
  test(`自评计分策略 ${scoring}：教师读面与学生成绩按声明口径给出正确数，自评对错始终单列`, t => {
    const runtime = open(t);
    const { activity, key } = handInWhole(runtime, `self-${scoring}`, scoring);
    assert.deepEqual(runtime.readResults(student, activity.activityId, "assessment"), { assessment: { status: "pending" } });
    runtime.selfAssess(student, activity.activityId, key, command(essay.id, "essay", 0, "correct"));
    assert.deepEqual(runtime.readResults(student, activity.activityId, "assessment"), { assessment: { status: "pending" } });
    runtime.selfAssess(student, activity.activityId, key, command(reflection.id, "reflection", 0, "wrong"));
    assert.deepEqual(counts(runtime, activity, key), {
      scoring, questionCount: 3, judgedCorrect: 1, judgedWrong: 0, selfAssessedCorrect: 1, selfAssessedWrong: 1, pending: 0, correctCount,
    });
    assert.deepEqual(runtime.readResults(student, activity.activityId, "assessment"), {
      assessment: {
        status: "complete", correctCount, questionCount: 3,
        selfAssessment: { scoring, judgedCorrect: 1, selfAssessedCorrect: 1, selfAssessedWrong: 1 },
      },
    });
  });
}

test("未声明自评的练法成绩口径不变：自评题只认教师或自动判定", t => {
  const runtime = open(t);
  const { activity, key, receipt } = handInWhole(runtime, "self-absent", undefined);
  assert.throws(() => runtime.selfAssess(student, activity.activityId, key, command(essay.id, "essay", 0, "correct")),
    { status: 409, code: "SELF_ASSESSMENT_NOT_AVAILABLE" });
  assert.throws(() => runtime.readSelfAssessments(student, activity.activityId, key), { status: 409, code: "SELF_ASSESSMENT_NOT_AVAILABLE" });
  assert.equal(runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts").selfAssessment, undefined);
  for (const [index, question] of [essay, reflection].entries()) {
    runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key,
      override({ receipt, questionId: question.id, operationId: `mark-${question.id}`, expectedRevision: 0 }, index === 0));
  }
  assert.deepEqual(runtime.readResults(student, activity.activityId, "assessment"), { assessment: { status: "complete", correctCount: 2, questionCount: 3 } });
});

test("自评修订竞争、操作幂等与细则：省略细则沿用上一修订，传空清除，换题重放报操作冲突", t => {
  const runtime = open(t);
  const { activity, key } = handInWhole(runtime, "self-cas", "separate");
  const assess = (input: SelfAssessmentInput) => runtime.selfAssess(student, activity.activityId, key, input);
  const first = assess(command(essay.id, "rate", 0, "correct", { clarity: 3, evidence: "引用充分" }));
  assert.deepEqual(first.rubric, { clarity: 3, evidence: "引用充分" });
  assert.deepEqual(assess(command(essay.id, "rate", 0, "correct", { evidence: "引用充分", clarity: 3 })), first);
  assert.throws(() => assess(command(essay.id, "rate", 0, "correct", { clarity: 2 })), { status: 409, code: "OPERATION_CONFLICT" });
  assert.throws(() => assess(command(reflection.id, "rate", 0, "correct")), { status: 409, code: "OPERATION_CONFLICT" });
  assert.throws(() => assess(command(essay.id, "stale", 0, "wrong")), { status: 409, code: "SELF_ASSESSMENT_CONFLICT" });
  const kept = assess(command(essay.id, "flip", 1, "wrong"));
  assert.deepEqual([kept.revision, kept.verdict, kept.rubric], [2, "wrong", { clarity: 3, evidence: "引用充分" }]);
  assert.deepEqual(assess(command(essay.id, "flip", 1, "wrong")), kept);
  const cleared = assess(command(essay.id, "clear", 2, null, {}));
  assert.deepEqual([cleared.revision, cleared.verdict, cleared.rubric], [3, null, undefined]);
  const [view] = runtime.readSelfAssessments(student, activity.activityId, key).questions;
  assert.deepEqual(view && { ...view, selfAssessment: { ...view.selfAssessment, assessedAt: undefined } },
    { questionId: essay.id, questionVersion: 1, selfAssessment: { source: "self", revision: 3, verdict: null, assessedAt: undefined } });
  assert.throws(() => assess({ ...command(essay.id, "bad", 3, "correct"), rubric: { "": 1 } }), { name: "ZodError" });
});

test("教师改判取代自评且之后拒绝自评，撤销后自评重新计入；教师读面保留自评记录", t => {
  const runtime = open(t);
  const { activity, key, receipt } = handInWhole(runtime, "self-teacher", "countAsCorrect");
  runtime.selfAssess(student, activity.activityId, key, command(essay.id, "essay", 0, "correct"));
  const marked = runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key,
    override({ receipt, questionId: essay.id, operationId: "mark", expectedRevision: 0 }, false));
  assert.deepEqual([counts(runtime, activity, key).judgedWrong, counts(runtime, activity, key).correctCount], [1, 1]);
  assert.throws(() => runtime.selfAssess(student, activity.activityId, key, command(essay.id, "late", 1, "wrong")),
    { status: 409, code: "SELF_ASSESSMENT_TEACHER_JUDGED" });
  const essayView = runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts").questions
    .find(({ questionId }) => questionId === essay.id);
  assert.ok(essayView && "selfAssessment" in essayView);
  assert.deepEqual([essayView.status, essayView.selfAssessment.verdict], ["judged", "correct"]);
  runtime.writeQuestionDeliveryVerdict(reviewer, activity.activityId, key,
    withdraw({ receipt, questionId: essay.id, operationId: "undo", expectedRevision: 1 }, marked.id));
  assert.deepEqual([counts(runtime, activity, key).selfAssessedCorrect, counts(runtime, activity, key).correctCount], [1, 2]);
  assert.equal(runtime.selfAssess(student, activity.activityId, key, command(essay.id, "again", 1, "wrong")).revision, 2);
});

test("逐题交付只能自评本次交付中的题；不认识的交付键与他人的活动被拒", t => {
  const runtime = open(t);
  runtime.publish(deliveryPublication(declaration("self-per", "separate", "perQuestion")));
  const activity = startFor(runtime, "self-per");
  const draft = saveDraft(runtime, activity, essay, pendingToken);
  const input = deliveryInput(activity, "question", [{ question: essay, revision: draft.revision }], "essay-only");
  runtime.confirmQuestionDelivery(student, activity.activityId, input);
  runtime.evaluatePending();
  const key = recoveryKey(input);
  assert.throws(() => runtime.selfAssess(student, activity.activityId, key, command(reflection.id, "other", 0, "correct")),
    { status: 403, code: "FORBIDDEN" });
  assert.throws(() => runtime.selfAssess(student, activity.activityId, { ...key, operationId: "missing" }, command(essay.id, "x", 0, "correct")),
    { status: 404, code: "CONFIRMATION_NOT_FOUND" });
  assert.equal(runtime.selfAssess(student, activity.activityId, key, command(essay.id, "essay", 0, "correct")).revision, 1);
  assert.deepEqual(runtime.readSelfAssessments(student, activity.activityId, key).questions.map(({ questionId }) => questionId), [essay.id]);
  assert.throws(() => runtime.selfAssess(outsider, activity.activityId, key, command(essay.id, "intrude", 1, "wrong")), { status: 403, code: "FORBIDDEN" });
});

test("发布时校验自评声明：自评题与计分策略须同时声明，自评题须已发布且有评估去向", t => {
  const runtime = open(t);
  const base = declaration("self-invalid", "separate");
  const publish = (changes: Partial<DeliveryDeclaration>) => () => runtime.publish(deliveryPublication({ ...base, ...changes }));
  assert.throws(publish({ policy: policy(undefined) }), /自评题与自评计分策略须同时声明/);
  assert.throws(publish({ grading: { ...base.grading, selfReview: [] } }), /自评题与自评计分策略须同时声明/);
  assert.throws(publish({ grading: { ...base.grading, selfReview: ["ghost"] } }), /自评须绑定已发布的题/);
  assert.throws(publish({ grading: { keys: {}, teacherReview: [objective.id], selfReview: [essay.id] } }), /自评题须同时声明评估或教师评阅/);
});
