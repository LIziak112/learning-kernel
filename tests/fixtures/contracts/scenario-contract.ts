import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { defineResponseType, LearningError, openLearningRuntime } from "../../../src/server.ts";
import type { EvaluatorRegistration, PublicationInput, QuestionDeliveryInput } from "../../../src/server.ts";
import { scenarioDatabase } from "../online-reading.ts";

export type ScenarioClause = "submit" | "authorize" | "failure" | "undo";
export const scenarioClauses: readonly ScenarioClause[] = ["submit", "authorize", "failure", "undo"];

const stubValue = z.strictObject({ token: z.string() });
const stubKey = z.strictObject({ acceptedToken: z.string() });
export const stubResponseType = defineResponseType({
  id: "contractStub",
  version: 1,
  validateQuestion(question, issue) {
    if (Object.keys(question.options).length > 0) issue(["options"], "桩题型不使用选项");
  },
  parseValue(value) {
    const parsed = stubValue.safeParse(value);
    if (!parsed.success) throw new LearningError(422, "INVALID_RESPONSE");
    return parsed.data;
  },
  isAnswered: value => value.token !== "",
  parseKey: key => stubKey.safeParse(key).data,
});

export const stubEvaluatorRef = { id: "contract-stub-evaluator", version: 1 };
export const stubKeyRef = { id: "contract-stub-key", version: 1 };
export const stubQuestions = [
  { id: "first", version: 1, prompt: "桩题一", response: stubResponseType.id },
  { id: "second", version: 1, prompt: "桩题二", response: stubResponseType.id },
] as const;
export const acceptedToken = "accepted";
export const stubScoringKey = { ...stubKeyRef, acceptedByQuestion: Object.fromEntries(stubQuestions.map(({ id }) =>
  [id, { response: stubResponseType.id, acceptedToken }])) };

export const student = { role: "student", id: "scenario-student" } as const;
export const outsider = { role: "student", id: "scenario-outsider" } as const;
export const reviewer = { role: "reviewer", id: "scenario-reviewer" } as const;

export class Harness {
  evaluations = 0;
  evaluatorBroken = false;
  studentRecovery = true;
  reviewAllowed = true;
  readonly databasePath: string;
  runtime: ReturnType<typeof openLearningRuntime>;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.runtime = this.open();
  }

  reopen() {
    this.runtime.close();
    this.runtime = this.open();
  }

  private open() {
    return openLearningRuntime({
      databasePath: this.databasePath, responseTypes: [stubResponseType], evaluators: [stubEvaluator(this)],
      verifyOriginal: () => true, authorizeConfirmationRecovery: () => this.studentRecovery,
      authorizeReview: access => this.reviewAllowed && access.reviewerId === reviewer.id && access.studentId === student.id,
    });
  }
}
export type Runtime = Harness["runtime"];

export type HandIn = Readonly<{
  activityId: string;
  input: QuestionDeliveryInput;
  key: Readonly<{ protocolVersion: 1; stepAttemptId: string; operationId: string }>;
  receipt: ReturnType<Runtime["confirmQuestionDelivery"]>;
  questionId: string;
  questionVersion: number;
}>;

export type ScenarioModule = Readonly<{
  group: string;
  title: string;
  publication(practiceId: string): PublicationInput;
  handIn(harness: Harness, practiceId: string, token: string): HandIn;
  notApplicable?: Partial<Readonly<Record<ScenarioClause, string>>>;
}>;

function stubEvaluator(harness: Harness): EvaluatorRegistration {
  return {
    ...stubEvaluatorRef, responseTypes: [stubResponseType.id],
    evaluate({ value, key }) {
      harness.evaluations += 1;
      if (harness.evaluatorBroken) throw new Error("stub evaluator down");
      return { status: "judged", correct: value !== null && stubValue.parse(value).token === stubKey.parse(key).acceptedToken };
    },
  };
}

function openHarness(t: TestContext) {
  const harness = new Harness(scenarioDatabase(t));
  t.after(() => harness.runtime.close());
  return harness;
}

function reviewVerdicts(harness: Harness, handed: HandIn) {
  return harness.runtime.readQuestionDeliveryReview(reviewer, handed.activityId, handed.key, "verdicts");
}

function position(handed: HandIn) {
  return { questionId: handed.questionId, questionVersion: handed.questionVersion };
}

function verdictCommand(handed: HandIn, targetId: string) {
  return { protocolVersion: 1, submissionId: handed.receipt.id, targetId, questionId: handed.questionId } as const;
}

const clauses: Readonly<Record<ScenarioClause, (module: ScenarioModule, harness: Harness) => void>> = {
  submit(module, harness) {
    harness.runtime.publish(module.publication("submit"));
    const handed = module.handIn(harness, "submit", acceptedToken);
    const { runtime } = harness;
    assert.deepEqual(runtime.confirmQuestionDelivery(student, handed.activityId, handed.input), handed.receipt);
    assert.throws(() => runtime.confirmQuestionDelivery(student, handed.activityId, { ...handed.input, operationId: "competing" }),
      { status: 409, code: "ALREADY_SUBMITTED" });
    assert.deepEqual(runtime.recoverQuestionDelivery(student, handed.activityId, handed.key).evaluation, { status: "pending", evaluator: stubEvaluatorRef });
    runtime.evaluatePending();
    const evaluated = runtime.recoverQuestionDelivery(student, handed.activityId, handed.key);
    assert.deepEqual(evaluated.receipt, handed.receipt);
    assert.ok(evaluated.evaluation.status === "evaluated");
    assert.deepEqual(evaluated.evaluation.questions, [{ ...position(handed), result: { status: "judged", correct: true } }]);
    harness.reopen();
    assert.deepEqual(harness.runtime.confirmQuestionDelivery(student, handed.activityId, handed.input), handed.receipt);
    assert.deepEqual(harness.runtime.recoverQuestionDelivery(student, handed.activityId, handed.key), evaluated);
    assert.equal(harness.evaluations, 1);
  },

  authorize(module, harness) {
    harness.runtime.publish(module.publication("authorize"));
    const handed = module.handIn(harness, "authorize", acceptedToken);
    const { runtime } = harness;
    runtime.evaluatePending();
    const forbidden = { status: 403, code: "FORBIDDEN" };
    assert.throws(() => runtime.recoverQuestionDelivery(outsider, handed.activityId, handed.key), forbidden);
    assert.throws(() => runtime.confirmQuestionDelivery(outsider, handed.activityId, handed.input), forbidden);
    assert.throws(() => runtime.readQuestionDeliveryReview({ ...reviewer, id: "other-reviewer" }, handed.activityId, handed.key, "verdicts"),
      forbidden);
    assert.doesNotMatch(JSON.stringify(runtime.read(student, handed.activityId)), /acceptedToken|acceptedByQuestion|contract-stub-key/);
    harness.reviewAllowed = false;
    assert.throws(() => reviewVerdicts(harness, handed), forbidden);
    harness.studentRecovery = false;
    assert.throws(() => runtime.recoverQuestionDelivery(student, handed.activityId, handed.key), forbidden);
  },

  failure(module, harness) {
    harness.runtime.publish(module.publication("failure"));
    harness.evaluatorBroken = true;
    const handed = module.handIn(harness, "failure", acceptedToken);
    const { runtime } = harness;
    const scope = { submissionId: handed.receipt.id };
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 1, failed: 0, deferred: 0 });
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 1, deferred: 0 });
    harness.evaluatorBroken = false;
    assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
    assert.equal(harness.evaluations, 3);
    assert.deepEqual(runtime.recoverQuestionDelivery(student, handed.activityId, handed.key).evaluation,
      { status: "failed", evaluator: stubEvaluatorRef });
    assert.doesNotMatch(JSON.stringify(runtime.read(student, handed.activityId)), /stub evaluator down|EVALUATOR_FAILED/);
    const failed = reviewVerdicts(harness, handed);
    assert.deepEqual(failed.questions, [{ ...position(handed), revision: 0, status: "evaluationFailed" }]);
    const mark = runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key, {
      ...verdictCommand(handed, failed.targetId), operationId: "manual", expectedRevision: 0, action: "override", correct: true,
      reason: "评估失败，人工判定",
    });
    assert.deepEqual(reviewVerdicts(harness, handed).questions, [{ ...position(handed), revision: 1, status: "judged",
      effective: { source: "teacherReview", id: mark.id, correct: true } }]);
  },

  undo(module, harness) {
    harness.runtime.publish(module.publication("undo"));
    const handed = module.handIn(harness, "undo", "wrong");
    const { runtime } = harness;
    runtime.evaluatePending();
    const before = reviewVerdicts(harness, handed);
    const studentBefore = runtime.recoverQuestionDelivery(student, handed.activityId, handed.key);
    assert.deepEqual(before.questions, [{ ...position(handed), revision: 0, status: "judged",
      automatic: { correct: false, valid: true }, effective: { source: "automatic", correct: false } }]);
    const command = verdictCommand(handed, before.targetId);
    const mark = runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key, {
      ...command, operationId: "amend", expectedRevision: 0, action: "override", correct: true, reason: "教师改判",
    });
    assert.deepEqual(reviewVerdicts(harness, handed).questions, before.questions.map(verdict => ({ ...verdict, revision: 1,
      effective: { source: "teacherReview", id: mark.id, correct: true } })));
    runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key, {
      ...command, operationId: "undo", expectedRevision: 1, action: "withdraw", withdrawId: mark.id, reason: "撤销改判",
    });
    assert.deepEqual(reviewVerdicts(harness, handed).questions, before.questions.map(verdict => ({ ...verdict, revision: 2 })));
    assert.deepEqual(runtime.recoverQuestionDelivery(student, handed.activityId, handed.key), studentBefore);
  },
};

export function scenarioContract(module: ScenarioModule) {
  for (const clause of scenarioClauses) {
    const reason = module.notApplicable?.[clause];
    if (reason !== undefined) {
      assert.ok(reason.trim() !== "", `${module.group} ${clause} 标不适用须写理由`);
      continue;
    }
    test(`模块契约 ${module.group} ${module.title}｜${clause}`, t => clauses[clause](module, openHarness(t)));
  }
}
