import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { openLearningRuntime } from "learning-kernel";
import type { Evaluator, PublicationInput, ResponseConfirmationInput } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["write", "recover", "read-stored"]).parse(process.argv[2]);
const student = { role: "student", id: "indexed-learner" } as const;
const id = "indexed-consumer";
const evaluator = { id: "consumer-index-evaluator", version: 1 };
const questionIds = ["ordered", "empty", "absent"];
const ordered = [2, 0, 2];
const operationId = "hand-in";
const protocolVersion = 1;
const slotId = "answers";

const evaluate: Evaluator = ({ responseType, value, key, questionId, practice }) => {
  assert.equal(responseType, "optionIndexArray");
  const { acceptedIndexes } = z.strictObject({ acceptedIndexes: z.array(z.int()) }).parse(key);
  assert.equal(practice.version, 1);
  assert.deepEqual(acceptedIndexes, [0, 2]);
  if (questionId === "ordered") assert.deepEqual(value, ordered);
  if (questionId === "empty") assert.deepEqual(value, []);
  if (questionId === "absent") assert.equal(value, null);
  return { status: "judged", correct: questionId === "ordered" };
};
const runtime = openLearningRuntime({
  databasePath: "index-response.sqlite",
  ...(phase !== "read-stored" && { evaluators: [{ ...evaluator, responseTypes: ["optionIndexArray"], evaluate }] }),
  authorizeConfirmationRecovery: ({ studentId, operationId: requested }) => studentId === student.id && requested === operationId,
});
function publication(version: number, accepted: number[]) {
  const key = { id: "fixture-index-key", version };
  return {
    scoringKey: { ...key, acceptedIndexes: Object.fromEntries(questionIds.map(id => [id, accepted])) },
    practice: {
      id, version, formatVersion: 1, title: "独立原索引作答", goals: { answer: "确认全部选择" },
      questions: questionIds.map(id => ({ id, version: 1, prompt: "选择项目", options: { "0": "甲", "1": "乙", "2": "丙" } })),
      steps: [{ id: "answer", instructions: "提交选择", tool: { id: "response-group", version: 1 },
        inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { answers: {
          type: "oneResponsePerQuestion", input: "optionIndexArray", source: "questions", targetId: "answer",
          confirmFromDrafts: { allowUnanswered: true },
        } } }, afterConfirmation: "finish",
      }],
      grading: { assessment: {
        evaluator, keyRef: key, from: { stepId: "answer", slotId }, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
      } },
      policy: { offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  } satisfies PublicationInput;
}

const evidence = "index-response-opening.json";
const opening = { protocolVersion, practiceId: id, practiceVersion: 1, operationId: "open" } as const;
try {
  if (phase === "write") {
    runtime.publish(publication(1, [0, 2]));
    const { activityId, stepAttemptId } = runtime.start(student, opening);
    const input: ResponseConfirmationInput = { protocolVersion, stepAttemptId, slotId, operationId, questions: questionIds.map(questionId => {
      const revision = questionId === "absent" ? 0 : runtime.saveResponseDraft(student, activityId, {
        protocolVersion, stepAttemptId, slotId, questionId, questionVersion: 1,
        operationId: "save", baseRevision: 0, value: questionId === "ordered" ? ordered : [],
      }).revision;
      return { questionId, questionVersion: 1, revision, original: { state: "uncollected" } };
    }) };
    const active = runtime.read(student, activityId);
    assert.ok("responseDrafts" in active);
    assert.deepEqual(active.responseDrafts.map(item => item.value), [[], ordered]);
    const receipt = runtime.confirmResponses(student, activityId, input);
    runtime.evaluatePending();
    assert.deepEqual(runtime.confirmResponses(student, activityId, input), receipt);
    runtime.publish(publication(2, [1]));
    writeFileSync(evidence, JSON.stringify({ activityId, stepAttemptId, receiptId: receipt.id }));
  } else {
    const scope = z.strictObject({ activityId: z.uuid(), stepAttemptId: z.uuid(), receiptId: z.uuid() })
      .parse(JSON.parse(readFileSync(evidence, "utf8")));
    assert.equal(runtime.start(student, opening).activityId, scope.activityId);
    const key = { protocolVersion, stepAttemptId: scope.stepAttemptId, operationId } as const;
    assert.throws(() => runtime.recoverResponseConfirmation({ ...student, id: "other" }, scope.activityId, key), { code: "FORBIDDEN" });
    const confirmation = runtime.recoverResponseConfirmation(student, scope.activityId, key);
    assert.equal(confirmation.receipt.id, scope.receiptId);
    assert.deepEqual(confirmation.confirmation.questions.map(item => item.value), [ordered, [], null]);
    assert.equal(confirmation.evaluation.correctCount, 1);
    const view = runtime.read(student, scope.activityId);
    assert.ok("formatVersion" in view);
    assert.deepEqual(view.submission?.responseConfirmation, confirmation.confirmation);
    assert.doesNotMatch(JSON.stringify([view, confirmation]), /acceptedIndexes|acceptedResponses|scoringKey/);
  }
} finally { runtime.close(); }
