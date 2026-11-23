import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { openLearningRuntime } from "learning-kernel";
import type { Evaluator, PublicationInput, ResponseConfirmationInput } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["write", "recover", "read-stored"]).parse(process.argv[2]);
const student = { role: "student", id: "learner" } as const;
const practice = { id: "frozen-judgment", version: 1 };
const assessment = { id: "local-judgment", version: 1 };
const questions = ["open-text", "boolean-control"];
const text = "  待教师辨认的判断文本  ";
const original = { state: "frozen", documentId: "original", versionId: "V1" } as const;
const evaluate: Evaluator = ({ questionId, value, key }) => {
  const { acceptedResponse } = z.strictObject({ acceptedResponse: z.boolean() }).parse(key);
  if (questionId === "open-text") {
    assert.equal(value, text);
    return { status: "needsReview" };
  }
  assert.equal(value, false);
  assert.equal(acceptedResponse, false);
  return { status: "judged", correct: true };
};
const protocolVersion = 1;
const operationId = "hand-in";
const slotId = "answers";
const runtime = openLearningRuntime({
  databasePath: "response.sqlite",
  ...(phase !== "read-stored" && { evaluators: [{ ...assessment, responseTypes: ["booleanOrString"], evaluate }] }),
  authorizeConfirmationRecovery: scope => scope.studentId === student.id && scope.operationId === operationId,
  verifyOriginal: scope => scope.original.state === "uncollected" ||
    (scope.original.state === "frozen" && scope.original.documentId === original.documentId && scope.original.versionId === original.versionId),
});

const publication = {
  scoringKey: { ...practice, acceptedResponses: { "open-text": true, "boolean-control": false } },
  practice: {
    ...practice, formatVersion: 1, title: "独立判断作品", goals: { answer: "提交原值" },
    questions: questions.map(id => ({ id, version: 1, prompt: "判断这一说法", options: { yes: "对", no: "错" } })),
    steps: [{
      id: "answer", instructions: "提交判断", tool: { id: "response-group", version: 1 },
      inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { answers: {
        type: "oneResponsePerQuestion", input: "booleanOrString", source: "questions", targetId: "answer",
        confirmFromDrafts: { allowUnanswered: false },
      } } }, afterConfirmation: "finish",
    }],
    grading: { assessment: {
      evaluator: assessment, keyRef: practice, from: { stepId: "answer", slotId },
      unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
    } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  },
} satisfies PublicationInput;

const evidence = "response-receipt.json";
try {
  if (phase === "write") {
    runtime.publish(publication);
    const { activityId, stepAttemptId } = runtime.start(student, {
      protocolVersion, operationId: "open", practiceId: practice.id, practiceVersion: practice.version,
    });
    const input: ResponseConfirmationInput = { protocolVersion, stepAttemptId, slotId, operationId, questions: questions.map((questionId, index) => {
      const draft = runtime.saveResponseDraft(student, activityId, {
        protocolVersion, stepAttemptId, slotId, questionId, questionVersion: 1,
        operationId: "save", baseRevision: 0, value: index === 0 ? text : false,
      });
      return { questionId, questionVersion: 1, revision: draft.revision, original: index === 0 ? original : { state: "uncollected" } };
    }) };
    const receipt = runtime.confirmResponses(student, activityId, input);
    assert.deepEqual(runtime.confirmResponses(student, activityId, input), receipt);
    writeFileSync(evidence, JSON.stringify({ activityId, stepAttemptId, receiptId: receipt.id }));
  } else {
    const scope = z.strictObject({ activityId: z.uuid(), stepAttemptId: z.uuid(), receiptId: z.uuid() }).parse(JSON.parse(readFileSync(evidence, "utf8")));
    const key = { protocolVersion, stepAttemptId: scope.stepAttemptId, operationId } as const;
    assert.throws(() => runtime.recoverResponseConfirmation({ ...student, id: "other" }, scope.activityId, key), { code: "FORBIDDEN" });
    const confirmed = runtime.recoverResponseConfirmation(student, scope.activityId, key);
    assert.equal(confirmed.receipt.id, scope.receiptId);
    assert.deepEqual(confirmed.confirmation.questions.map(item => item.value), [text, false]);
    assert.deepEqual(confirmed.confirmation.questions[0]?.original, original);
    assert.deepEqual(confirmed.evaluation.questions.map(item => item.result), [{ status: "needsReview" }, { status: "judged", correct: true }]);
    const view = runtime.read(student, scope.activityId);
    assert.ok("formatVersion" in view);
    assert.equal(view.submission?.receipt?.id, scope.receiptId);
    assert.doesNotMatch(JSON.stringify(view), /acceptedResponses|correctCount|needsReview/);
  }
} finally {
  runtime.close();
}
