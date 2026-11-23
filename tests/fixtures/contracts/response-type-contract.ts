import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openLearningRuntime } from "../../../src/server.ts";
import type {
  EvaluatorRegistration, PublicationInput, QuestionDeliveryDraftInput, QuestionDeliveryInput, RegisteredResponseType, VerdictResult,
} from "../../../src/server.ts";
import { scenarioDatabase } from "../online-reading.ts";

type ReadingPractice = Extract<PublicationInput, { practice: { formatVersion: 1 } }>["practice"];
type Runtime = ReturnType<typeof openLearningRuntime>;
type DraftValue = QuestionDeliveryDraftInput["value"];
type Reference = Readonly<{ id: string; version: number }>;

export type ContractQuestion = Readonly<{
  id: string; version: number; prompt: string; response: string; options?: Readonly<Record<string, string>>;
}> & Readonly<Record<string, unknown>>;

export type GradingPath =
  | Readonly<{ path: "automatic"; evaluator: Reference; register?: EvaluatorRegistration; key: Readonly<Record<string, unknown>> }>
  | Readonly<{ path: "teacherReview" }>
  | Readonly<{ path: "manualReview"; reviewCriteria: string }>;

export type ContractAnswer = Readonly<{ value: DraftValue; stored?: DraftValue; result: VerdictResult }>;

export type ResponseTypeRow = Readonly<{
  row: string;
  question: ContractQuestion;
  responseTypes?: readonly RegisteredResponseType[];
  grading: GradingPath;
  answers: readonly ContractAnswer[];
  unansweredDraft?: DraftValue;
  missingDraft: VerdictResult;
}>;

const student = { role: "student", id: "contract-student" } as const;
const reviewer = { role: "reviewer", id: "contract-reviewer" } as const;
const slotId = "work";
const targetId = "answer";
const keyRef = { id: "contract-key", version: 1 };
const assessmentFrom = { stepId: "answer", slotId };

function gradingOf({ question, grading }: ResponseTypeRow): ReadingPractice["grading"] {
  if (grading.path === "automatic") return { assessment: {
    from: assessmentFrom, evaluator: { id: grading.evaluator.id, version: grading.evaluator.version }, keyRef,
    unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
  } };
  if (grading.path === "manualReview") return { manualReview: { keyRef } };
  return { teacherReview: { questionIds: [question.id] } };
}

function scoringKeyOf({ question, grading }: ResponseTypeRow) {
  if (grading.path === "automatic") return { ...keyRef, acceptedByQuestion: { [question.id]: { response: question.response, ...grading.key } } };
  if (grading.path === "manualReview") return { ...keyRef, reviewCriteria: grading.reviewCriteria };
  return undefined;
}

function publication(row: ResponseTypeRow, practiceId: string, allowUnanswered: boolean) {
  const practice = {
    id: practiceId, version: 1, formatVersion: 1, title: "题型契约", goals: { [targetId]: "作答" }, questions: [row.question],
    steps: [{
      id: "answer", instructions: "作答。", tool: { id: "question-delivery", version: 1 }, inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { [slotId]: {
        type: "questionDelivery", source: "questions", targetId, delivery: { mode: "whole" }, confirmFromDrafts: { allowUnanswered },
      } } },
      afterConfirmation: "finish",
    }],
    grading: gradingOf(row),
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  } satisfies ReadingPractice;
  const scoringKey = scoringKeyOf(row);
  return (scoringKey ? { practice, scoringKey } : { practice }) satisfies PublicationInput;
}

function openRuntime(row: ResponseTypeRow, databasePath: string) {
  const registered = row.grading.path === "automatic" ? row.grading.register : undefined;
  return openLearningRuntime({
    databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true, authorizeReview: () => true,
    ...row.responseTypes && { responseTypes: [...row.responseTypes] },
    ...registered && { evaluators: [registered] },
  });
}

function handIn(runtime: Runtime, row: ResponseTypeRow, practiceId: string, draft: { value: DraftValue } | undefined) {
  const activity = runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: `start-${practiceId}` });
  const { id: questionId, version: questionVersion } = row.question;
  const saved = draft && runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId, questionVersion,
    operationId: "save", baseRevision: 0, value: draft.value,
  });
  const input = {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, source: "whole", operationId: "hand-in",
    questions: [{ questionId, questionVersion, revision: saved?.revision ?? 0, original: { state: "uncollected" } }],
  } satisfies QuestionDeliveryInput;
  return { activity, input, key: { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, operationId: input.operationId } };
}

type Handed = ReturnType<typeof handIn>;

function verdicts(runtime: Runtime, { activity, key }: Handed) {
  return runtime.readQuestionDeliveryReview(reviewer, activity.activityId, key, "verdicts").questions;
}

function storedValues(runtime: Runtime, { activity, key }: Handed) {
  return runtime.recoverQuestionDelivery(student, activity.activityId, key, "declared").confirmation.questions.map(({ value }) => value);
}

function expectedVerdict(row: ResponseTypeRow, result: VerdictResult) {
  const position = { questionId: row.question.id, questionVersion: row.question.version, revision: 0 };
  if (result.status === "needsReview") return { ...position, status: "needsReview" };
  return { ...position, status: "judged", automatic: { correct: result.correct, valid: true },
    effective: { source: "automatic", correct: result.correct } };
}

function confirmAndEvaluate(runtime: Runtime, row: ResponseTypeRow, practiceId: string, draft: { value: DraftValue } | undefined) {
  runtime.publish(publication(row, practiceId, true));
  const handed = handIn(runtime, row, practiceId, draft);
  const receipt = runtime.confirmQuestionDelivery(student, handed.activity.activityId, handed.input);
  runtime.evaluatePending();
  return { ...handed, receipt };
}

export function responseTypeContract(row: ResponseTypeRow) {
  assert.ok(row.answers.length > 0, `${row.row} 至少给一个作答样例`);

  test(`题型契约 ${row.row}｜判分：每个样例原值入卷，按行判对、判错或进待批`, t => {
    const runtime = openRuntime(row, scenarioDatabase(t));
    try {
      row.answers.forEach(({ value, stored = value, result }, index) => {
        const handed = confirmAndEvaluate(runtime, row, `judge-${index}`, { value });
        assert.deepEqual(storedValues(runtime, handed), [stored]);
        assert.deepEqual(verdicts(runtime, handed), [expectedVerdict(row, result)]);
      });
    } finally { runtime.close(); }
  });

  test(`题型契约 ${row.row}｜空答：必答时拒绝未答，允许未答时缺稿按行判定`, t => {
    const runtime = openRuntime(row, scenarioDatabase(t));
    try {
      runtime.publish(publication(row, "required", false));
      const missing = handIn(runtime, row, "required", undefined);
      assert.throws(() => runtime.confirmQuestionDelivery(student, missing.activity.activityId, missing.input),
        { status: 422, code: "UNANSWERED_QUESTION" });
      if (row.unansweredDraft !== undefined) {
        runtime.publish(publication(row, "required-draft", false));
        const blank = handIn(runtime, row, "required-draft", { value: row.unansweredDraft });
        assert.throws(() => runtime.confirmQuestionDelivery(student, blank.activity.activityId, blank.input),
          { status: 422, code: "UNANSWERED_QUESTION" });
      }
      const handed = confirmAndEvaluate(runtime, row, "optional", undefined);
      assert.deepEqual(storedValues(runtime, handed), [null]);
      assert.deepEqual(verdicts(runtime, handed), [expectedVerdict(row, row.missingDraft)]);
    } finally { runtime.close(); }
  });

  test(`题型契约 ${row.row}｜改判/清除：每个样例教师改判生效且学生回取不变，清除后回落到原判或待批`, t => {
    const runtime = openRuntime(row, scenarioDatabase(t));
    try {
      row.answers.forEach(({ value, result }, index) => {
        const handed = confirmAndEvaluate(runtime, row, `amend-${index}`, { value });
        const { activityId } = handed.activity;
        const before = verdicts(runtime, handed);
        const studentBefore = runtime.recoverQuestionDelivery(student, activityId, handed.key, "declared");
        const location = { protocolVersion: 1, submissionId: handed.receipt.id, targetId, questionId: row.question.id } as const;
        const amended = !(result.status === "judged" && result.correct);
        const mark = runtime.writeQuestionDeliveryVerdict(reviewer, activityId, handed.key, {
          ...location, operationId: "amend", expectedRevision: 0, action: "override", correct: amended, reason: "契约改判",
        });
        assert.deepEqual(verdicts(runtime, handed), [{ ...expectedVerdict(row, result), revision: 1, status: "judged",
          effective: { source: "teacherReview", id: mark.id, correct: amended } }]);
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activityId, handed.key, "declared"), studentBefore);
        runtime.writeQuestionDeliveryVerdict(reviewer, activityId, handed.key, {
          ...location, operationId: "clear", expectedRevision: 1, action: "withdraw", withdrawId: mark.id, reason: "契约清除",
        });
        assert.deepEqual(verdicts(runtime, handed), before.map(verdict => ({ ...verdict, revision: 2 })));
        assert.deepEqual(runtime.recoverQuestionDelivery(student, activityId, handed.key, "declared"), studentBefore);
        assert.doesNotMatch(JSON.stringify(studentBefore), /契约改判|契约清除|"source":"teacherReview"|acceptedByQuestion/);
      });
    } finally { runtime.close(); }
  });
}
