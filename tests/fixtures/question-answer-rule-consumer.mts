import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { openLearningRuntime } from "learning-kernel";
import type { PublicationInput, QuestionAnswerRule, QuestionDeliveryInput, ResponseValue } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["write", "recover"]).parse(process.argv[2]);
const checkpoint = z.strictObject({ activityId: z.uuid(), stepAttemptId: z.uuid(), receiptId: z.uuid() });
const student = { role: "student", id: "independent-rule-learner" } as const;
const evaluator = { id: "independent-scalar-evaluator", version: 1 };
const ruleRef = { id: "independent-private-presence", version: 2 };
const keyRef = { id: "independent-scalar-key", version: 1 };
const questionId = "independent-judgment";
const slotId = "answers";
const practiceId = "independent-rule";
const seen: ResponseValue[] = [];
const registration = {
  ...ruleRef, responseType: "booleanOrString", isAnswered(raw) {
    const value = z.union([z.boolean(), z.string()]).parse(raw);
    seen.push(value);
    return typeof value === "boolean" || value.trim() !== "";
  },
} satisfies QuestionAnswerRule;

const runtime = openLearningRuntime({
  databasePath: "independent-rule.sqlite",
  evaluators: [{ ...evaluator, responseTypes: ["booleanOrString"], evaluate: ({ value }) => ({ status: "judged", correct: value === false }) }],
  authorizeConfirmationRecovery: ({ studentId }) => studentId === student.id,
  ...(phase === "write" && { questionAnswerRules: [registration] }),
});

const publication = {
  practice: {
    id: practiceId, version: 1, formatVersion: 1, title: "独立作答规则",
    goals: { answer: "完成判断" },
    questions: [{ id: questionId, version: 5, response: "booleanOrString", prompt: "判断观察。", options: { yes: "对", no: "错" } }],
    questionAnswerRules: { [questionId]: ruleRef },
    steps: [{
      id: "answer", instructions: "保存并确认。", tool: { id: "question-delivery", version: 1 },
      inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { [slotId]: {
        type: "questionDelivery", source: "questions", targetId: "answer",
        confirmFromDrafts: { allowUnanswered: false }, delivery: { mode: "whole" },
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
  scoringKey: { ...keyRef, acceptedByQuestion: { [questionId]: { response: "booleanOrString", acceptedResponse: false } } },
} satisfies PublicationInput;

function confirmIntent(stepAttemptId: string, revision: number): QuestionDeliveryInput {
  return { protocolVersion: 1, stepAttemptId, slotId, operationId: "confirm", source: "whole",
    questions: [{ questionId, questionVersion: 5, revision, original: { state: "uncollected" } }],
  };
}

function view(activityId: string) {
  const activity = runtime.read(student, activityId);
  assert.ok("questionDeliveryDrafts" in activity);
  assert.doesNotMatch(JSON.stringify(activity), /questionAnswerRules|independent-private-presence|isAnswered|"answered"/);
  return activity;
}

function write() {
  runtime.publish(publication);
  const { activityId, stepAttemptId } = runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: "start" });
  const draft = { protocolVersion: 1, stepAttemptId, slotId, questionId, questionVersion: 5 } as const;
  const empty = runtime.saveQuestionDeliveryDraft(student, activityId, { ...draft, operationId: "empty", baseRevision: 0, value: "  " });
  assert.throws(() => runtime.confirmQuestionDelivery(student, activityId, confirmIntent(stepAttemptId, empty.revision)),
    { code: "UNANSWERED_QUESTION" });
  assert.deepEqual(view(activityId).questionDeliveryDrafts, [empty]);
  const saved = runtime.saveQuestionDeliveryDraft(student, activityId, { ...draft, operationId: "write", baseRevision: 1, value: false });
  const receipt = runtime.confirmQuestionDelivery(student, activityId, confirmIntent(stepAttemptId, saved.revision));
  runtime.evaluatePending();
  assert.deepEqual(seen, ["  ", false]);
  writeFileSync("independent-rule.json", JSON.stringify({ activityId, stepAttemptId, receiptId: receipt.id }));
}

function recover() {
  const { activityId, stepAttemptId, receiptId } = checkpoint.parse(JSON.parse(readFileSync("independent-rule.json", "utf8")));
  const confirmation = runtime.confirmQuestionDelivery(student, activityId, confirmIntent(stepAttemptId, 2));
  runtime.evaluatePending();
  const result = runtime.recoverQuestionDelivery(student, activityId, { protocolVersion: 1, stepAttemptId, operationId: "confirm" });
  assert.equal(confirmation.id, receiptId);
  assert.deepEqual(result.receipt, confirmation);
  assert.deepEqual(result.confirmation.questions.map(({ value }) => value), [false]);
  assert.deepEqual(view(activityId).questionDeliveries, [{ receipt: confirmation, questionDelivery: result.confirmation }]);
  assert.deepEqual(seen, []);
}

try {
  if (phase === "write") write();
  else recover();
  console.log(`独立答题规则宿主 ${phase} 通过`);
} finally { runtime.close(); }
