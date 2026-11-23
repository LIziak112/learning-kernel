import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { openLearningRuntime } from "learning-kernel";
import type { EvaluationInput, PublicationInput, ResponseValue } from "learning-kernel";
import { z } from "zod";

type Runtime = ReturnType<typeof openLearningRuntime>;
type Same<L, R> = [L] extends [R] ? [R] extends [L] ? true : false : false;
const scalarStable: Same<Parameters<Runtime["saveResponseDraft"]>[2]["value"], ResponseValue> = true;
type TitledTextResponseValue = { body: string; title?: string };
assert.ok(scalarStable);

const phase = z.enum(["write", "recover", "read-stored"]).parse(process.argv[2]);
const checkpoint = z.strictObject({ activityId: z.uuid(), stepAttemptId: z.uuid(), receiptId: z.uuid() });
const student = { role: "student", id: "independent-writer" } as const;
const format = "textWithOptionalTitle" as const;
const evaluator = { id: "independent-review", version: 2 };
const keyRef = { id: "independent-writing-key", version: 1 };
const practiceId = "independent-writing";
const slotId = "answers";
const body = "  第一段。\n\n第二段。  ";
const cases: readonly [string, TitledTextResponseValue | null][] = [
  ["only-title", { body: " \t\n\u3000", title: " 独立标题 " }],
  ["empty-title", { body, title: "" }], ["omitted-title", { body }], ["missing", null],
];
const seen: EvaluationInput[] = [];
const runtime = openLearningRuntime({
  databasePath: "independent-writing.sqlite",
  authorizeConfirmationRecovery: ({ studentId }) => studentId === student.id,
  ...(phase !== "read-stored" && { evaluators: [{
    ...evaluator,
    responseTypes: ["textWithOptionalTitle"],
    evaluate: input => {
      assert.deepEqual(input.key, {});
      seen.push(input);
      return { status: "needsReview" };
    },
  }] }),
});

const publication = {
  practice: {
    id: practiceId, version: 1, formatVersion: 1, title: "独立宿主文字作答",
    goals: { writing: "完成书面观察" },
    questions: cases.map(([id]) => ({ id, response: format, version: 3, prompt: "写下你的观察。" })),
    steps: [{
      id: "writing", instructions: "保存并确认。", tool: { id: "question-delivery", version: 1 },
      inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { [slotId]: {
        type: "questionDelivery", source: "questions", targetId: "writing",
        confirmFromDrafts: { allowUnanswered: true }, delivery: { mode: "whole" },
      } } },
      afterConfirmation: "finish",
    }],
    grading: { assessment: {
      from: { stepId: "writing", slotId }, evaluator, keyRef, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
    } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
    },
  },
  scoringKey: { ...keyRef, acceptedByQuestion: Object.fromEntries(cases.map(([id]) => [id, { response: format }])) },
} satisfies PublicationInput;

const operation = { protocolVersion: 1, operationId: "confirm-writing" } as const;

function write() {
  runtime.publish(publication);
  const { activityId, stepAttemptId } = runtime.start(student, { ...operation, practiceId, practiceVersion: 1 });
  const questions = cases.map(([questionId, value]) => {
    const saved = value === null ? null : runtime.saveQuestionDeliveryDraft(student, activityId, {
      protocolVersion: 1, stepAttemptId, slotId, questionId, questionVersion: 3, operationId: "save", baseRevision: 0, value,
    });
    assert.deepEqual(saved?.value ?? null, value);
    return { questionId, questionVersion: 3, revision: saved?.revision ?? 0, original: { state: "uncollected" as const } };
  });
  const input = { ...operation, stepAttemptId, slotId, source: "whole", questions } as const;
  const receipt = runtime.confirmQuestionDelivery(student, activityId, input);
  assert.deepEqual(runtime.confirmQuestionDelivery(student, activityId, input), receipt);
  assert.deepEqual(seen, []);
  writeFileSync("independent-writing.json", JSON.stringify({ activityId, stepAttemptId, receiptId: receipt.id }));
}

function read() {
  const { activityId, stepAttemptId, receiptId } = checkpoint.parse(JSON.parse(readFileSync("independent-writing.json", "utf8")));
  const key = { ...operation, stepAttemptId };
  const view = runtime.read(student, activityId);
  assert.ok("questionDeliveries" in view);
  assert.doesNotMatch(JSON.stringify(view), /acceptedByQuestion|independent-writing-key|needsReview/);
  assert.throws(() => runtime.recoverQuestionDelivery({ ...student, id: "outsider" }, activityId, key), { code: "FORBIDDEN" });
  if (phase === "recover") assert.deepEqual(runtime.evaluatePending(), { evaluated: 1, retrying: 0, failed: 0, deferred: 0 });
  const recovered = runtime.recoverQuestionDelivery(student, activityId, key);
  assert.equal(recovered.receipt.id, receiptId);
  assert.deepEqual(view.questionDeliveries, [{ receipt: recovered.receipt, questionDelivery: recovered.confirmation }]);
  assert.deepEqual(recovered.confirmation.questions.map(question => [question.questionId, question.value]), cases);
  assert.deepEqual(recovered.evaluation.evaluator, evaluator);
  assert.equal(recovered.evaluation.needsReviewCount, 4);
  assert.equal(seen.length, phase === "recover" ? 4 : 0);
  if (phase === "recover") {
    assert.deepEqual(seen.map(({ questionId, value }) => [questionId, value]), cases);
    assert.ok(seen.every(({ questionVersion, practice }) => questionVersion === 3 && practice.version === 1));
  }
  assert.deepEqual(runtime.recoverQuestionDelivery(student, activityId, key), recovered);
  assert.equal(seen.length, phase === "recover" ? 4 : 0);
}

try {
  if (phase === "write") write();
  else read();
  console.log(`独立文字宿主 ${phase} 通过`);
} finally { runtime.close(); }
