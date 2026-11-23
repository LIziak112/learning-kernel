import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z, ZodError } from "zod";
import { defineResponseType, LearningError, openLearningRuntime } from "../src/server.ts";
import type { EvaluationInput, PublicationInput, ToolCapability } from "../src/server.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "measuring-student" } as const;
const slotId = "work";
const measurement = z.strictObject({ amount: z.number(), unit: z.string() });
const measured = defineResponseType({
  id: "measuredAmount",
  version: 1,
  config: ["unit"],
  validateQuestion(question, issue) {
    if (typeof question.unit !== "string" || question.unit === "") issue(["unit"], "须冻结计量单位");
    if (Object.keys(question.options).length > 0) issue(["options"], "计量题不使用选项");
  },
  parseValue(value, question) {
    const parsed = measurement.safeParse(value);
    if (!parsed.success || parsed.data.unit !== question.unit) throw new LearningError(422, "INVALID_MEASUREMENT");
    return parsed.data;
  },
  isAnswered: value => Number.isFinite(value.amount),
  parseKey: key => z.strictObject({ acceptedAmount: z.number() }).safeParse(key).data,
});
const seen: EvaluationInput[] = [];
const evaluator = {
  id: "measure-check", version: 1, responseTypes: ["measuredAmount"],
  evaluate(input: EvaluationInput) {
    seen.push(input);
    const { amount } = measurement.parse(input.value);
    return { status: "judged" as const, correct: amount === z.strictObject({ acceptedAmount: z.number() }).parse(input.key).acceptedAmount };
  },
};
const question = { id: "length", version: 2, prompt: "量出线段长度。", response: "measuredAmount", unit: "cm" };
const keyRef = { id: "length-key", version: 1 };

type ReadingInput = Extract<PublicationInput, { practice: { formatVersion: 1 } }>;
type Questions = NonNullable<ReadingInput["practice"]["questions"]>;

function publication(questions: Questions = [question], tool = { id: "question-delivery", version: 1 }): ReadingInput {
  return {
    practice: {
      id: "measuring", version: 1, formatVersion: 1, title: "测量练习", goals: { measure: "读出长度" }, questions,
      steps: [{
        id: "measure", instructions: "填写长度。", tool, inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer" as const, slots: { [slotId]: {
          type: "questionDelivery" as const, source: "questions", targetId: "measure", delivery: { mode: "whole" as const },
          confirmFromDrafts: { allowUnanswered: false },
        } } },
        afterConfirmation: "finish" as const,
      }],
      grading: { assessment: { from: { stepId: "measure", slotId }, evaluator: { id: evaluator.id, version: 1 }, keyRef,
        unit: "question" as const, effectiveVerdictOrder: ["teacherReview", "automatic"] as ["teacherReview", "automatic"] } },
      policy: {
        offline: "onlineOnly" as const, redo: "newInstanceOnAuthorization" as const, externalAi: "disabled" as const,
        student: { ownSubmission: { scope: "ownConfirmedSubmissions" as const, fields: ["receipt" as const, "ownResponses" as const], onFinal: [] } },
        reviewer: { scope: "assignedReviewer" as const, fields: [], actions: [] }, manager: { scope: "assigningTeacher" as const, actions: [] },
      },
    },
    scoringKey: { ...keyRef, acceptedByQuestion: { [question.id]: { response: "measuredAmount", acceptedAmount: 12.5 } } },
  };
}

function issuePaths(error: unknown) {
  return error instanceof ZodError ? error.issues.map(issue => issue.path.join(".")) : [];
}

test("宿主经公开 SPI 登记新作答形态后，内核按形态校验题目、草稿、已答和私有键并调用评估器", t => {
  const databasePath = scenarioDatabase(t);
  const withoutType = openLearningRuntime({ databasePath });
  try {
    assert.throws(() => withoutType.publish(publication()), error => issuePaths(error).includes("practice.questions.0.response"));
  } finally { withoutType.close(); }
  const runtime = openLearningRuntime({
    databasePath, responseTypes: [measured], evaluators: [evaluator], authorizeConfirmationRecovery: () => true, verifyOriginal: () => true,
  });
  try {
    const { unit: _unit, ...unitless } = question;
    assert.throws(() => runtime.publish(publication([unitless])), error => issuePaths(error).includes("practice.questions.0.unit"));
    assert.throws(() => runtime.publish(publication([{ ...question, blankCount: 2 }])),
      error => issuePaths(error).includes("practice.questions.0.blankCount"));
    const wrongKey = publication();
    assert.throws(() => runtime.publish({ ...wrongKey, scoringKey: { ...keyRef, acceptedByQuestion: { [question.id]: { response: "measuredAmount" } } } }),
      error => issuePaths(error).includes("scoringKey.acceptedByQuestion.length"));
    runtime.publish(publication());
    const activity = runtime.start(student, { protocolVersion: 1, operationId: "open", practiceId: "measuring", practiceVersion: 1 });
    const draft = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion: 2,
      operationId: "save", baseRevision: 0 } as const;
    for (const value of [12.5, { amount: 12.5, unit: "mm" }, { amount: "12" , unit: "cm" }]) {
      assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...draft, value }),
        { status: 422, code: "INVALID_MEASUREMENT" });
    }
    const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, { ...draft, value: { amount: 12.5, unit: "cm" } });
    const input = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, slotId, source: "whole" as const, operationId: "hand-in",
      questions: [{ questionId: question.id, questionVersion: 2, revision: saved.revision, original: { state: "uncollected" as const } }] };
    runtime.confirmQuestionDelivery(student, activity.activityId, input);
    const recovered = runtime.recoverQuestionDelivery(student, activity.activityId,
      { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, operationId: "hand-in" });
    assert.deepEqual(recovered.evaluation.questions, [{ questionId: question.id, questionVersion: 2, result: { status: "judged", correct: true } }]);
    assert.equal(seen.length, 1);
    const [observed] = seen;
    assert.ok(observed);
    assert.equal(observed.responseType, "measuredAmount");
    assert.deepEqual(observed.value, { amount: 12.5, unit: "cm" });
    assert.deepEqual(observed.key, { acceptedAmount: 12.5 });
    assert.doesNotMatch(JSON.stringify(runtime.read(student, activity.activityId)), /acceptedAmount|acceptedByQuestion/);
  } finally { runtime.close(); }
});

test("材料位置只认工具能力声明的标记，不认具体工具名", t => {
  const databasePath = scenarioDatabase(t);
  const board: ToolCapability = { id: "measuring-board", version: 1, requiredInputs: ["questions"], optionalInputs: ["material"],
    outputs: ["questionDelivery"], supportsMaterialPositions: true };
  const plain: ToolCapability = { ...board, id: "plain-board", supportsMaterialPositions: false };
  const material = { id: "ruler-sheet", version: 1, source: "合成材料", title: "尺子图", paragraphs: [{ id: "p1", text: "一把尺子。" }] };
  const withMaterial = (tool: { id: string; version: number }): ReadingInput => {
    const base = publication([question], { id: tool.id, version: tool.version });
    const [step] = base.practice.steps;
    return { ...base, materials: [material], practice: { ...base.practice, steps: [{ ...step, inputs: { ...step.inputs,
      sheet: { from: "material" as const, positionId: "sheet", material: { id: material.id, version: material.version } } } }] } };
  };
  const runtime = openLearningRuntime({ databasePath, tools: [board, plain], responseTypes: [measured], evaluators: [evaluator] });
  try {
    assert.throws(() => runtime.publish(withMaterial(plain)), error => error instanceof ZodError
      && error.issues.some(issue => issue.message === "显式材料位置须绑定到声明支持材料位置的工具的单步最终作答"));
    runtime.publish(withMaterial(board));
  } finally { runtime.close(); }
  assert.throws(() => openLearningRuntime({ databasePath, tools: [{ ...board, id: "question-delivery" }] }), /工具重复登记/);
});
