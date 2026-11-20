import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { PublicationInput, QuestionDeliveryDraftInput, QuestionDeliveryInput, ResponseValue } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["write", "race-question", "race-finish", "recover", "read-stored"]).parse(process.argv[2]);
const student = { role: "student", id: "packaged-learner" } as const;
const evaluator = { id: "packaged-delivery", version: 1 };
const protocolVersion = 1;
const databasePath = "delivery.sqlite";
const raw = "  需要评阅  ";
const indexes = [2, 0, 2];
const slotId = "answers";

type Runtime = ReturnType<typeof openLearningRuntime>;
type LegacyDraftValue = ReturnType<Runtime["saveResponseDraft"]>["value"];
type SameType<Left, Right> = [Left] extends [Right] ? [Right] extends [Left] ? true : false : false;
const scalarStillExact: SameType<LegacyDraftValue, ResponseValue> = true;
assert.ok(scalarStillExact);

const runtime = openLearningRuntime({
  databasePath,
  authorizeConfirmationRecovery: ({ studentId }) => studentId === student.id,
  ...(phase !== "read-stored" && {
    choiceEvaluators: [{ ...evaluator, evaluate: ({ choice, acceptedChoice }) => choice === acceptedChoice }],
    responseEvaluators: [{ ...evaluator, evaluate: ({ value, acceptedResponse }) =>
      typeof value === "string" ? { status: "needsReview" } : { status: "judged", correct: value === acceptedResponse } }],
    indexResponseEvaluators: [{ ...evaluator, evaluate: ({ value, acceptedIndexes }) => {
      assert.deepEqual(acceptedIndexes, [0, 2]);
      return { status: "judged", correct: value !== null && [...new Set(value)].toSorted().join() === acceptedIndexes.join() };
    } }],
  }),
});

const published = {
  id: "grouped-delivery", version: 1, formatVersion: 1, title: "可独立安装的题组",
  goals: { answer: "提交作答" },
  questions: [
    { id: "choice", version: 2, response: "choice", prompt: "任选一个。", options: { yes: "是", no: "否" } },
    { id: "text", version: 3, response: "booleanOrString", prompt: "写下原话。", options: { yes: "是", no: "否" } },
    { id: "indexes", version: 4, response: "optionIndexArray", prompt: "请选择。", options: { "0": "甲", "1": "乙", "2": "丙" } },
  ],
  steps: [{
    id: "answer", instructions: "保存并交付。", tool: { id: "question-delivery", version: 1 },
    inputs: { questions: { from: "questions" } },
    submit: { purpose: "finalAnswer", slots: { answers: { type: "questionDelivery", source: "questions",
      targetId: "answer", confirmFromDrafts: { allowUnanswered: true }, delivery: { mode: "whole" },
    } } },
    afterConfirmation: "finish",
  }],
  grading: { assessment: {
    from: { stepId: "answer", slotId }, evaluator, keyRef: { id: "delivery-key", version: 1 }, unit: "question",
    effectiveVerdictOrder: ["teacherReview", "automatic"],
  } },
  policy: {
    offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
    student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
    reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
  },
} satisfies Extract<PublicationInput, { practice: { formatVersion: 1 } }>["practice"];

const scoringKey = { ...published.grading.assessment.keyRef, acceptedByQuestion: {
  choice: { response: "choice", acceptedChoice: "yes" },
  text: { response: "booleanOrString", acceptedResponse: true },
  indexes: { response: "optionIndexArray", acceptedIndexes: [0, 2] },
} } satisfies NonNullable<Extract<PublicationInput, { practice: { formatVersion: 1 } }>["scoringKey"]>;

const activityKey = z.object({ activityId: z.uuid(), stepAttemptId: z.uuid() });
const checkpoint = z.strictObject({ group: activityKey, individually: activityKey, groupReceipt: z.uuid() });
const file = "delivery-checkpoint.json";
type Activity = z.infer<typeof activityKey>;
type Revision = QuestionDeliveryInput["questions"][number];

function open(id: string) {
  return runtime.start(student, { protocolVersion, practiceId: id, practiceVersion: 1, operationId: id });
}

function draft(activity: Activity, questionId: string, questionVersion: number, value: QuestionDeliveryDraftInput["value"]) {
  return runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
    protocolVersion, stepAttemptId: activity.stepAttemptId, slotId, questionId, questionVersion, value, operationId: "save", baseRevision: 0,
  });
}
function current(questionId: string, questionVersion: number, revision: number): Revision {
  return { questionId, questionVersion, revision, original: { state: "uncollected" } };
}
function key(activity: Activity, operationId: string) {
  return { protocolVersion, stepAttemptId: activity.stepAttemptId, operationId } as const;
}

function write() {
  runtime.publish({ practice: published, scoringKey });
  const group = open("grouped-delivery");
  const groupAnswers = [draft(group, "choice", 2, "yes"), draft(group, "text", 3, raw), draft(group, "indexes", 4, indexes)];
  const groupReceipt = runtime.confirmQuestionDelivery(student, group.activityId, {
    ...key(group, "whole"), slotId, source: "whole",
    questions: groupAnswers.map(answer => current(answer.questionId, answer.questionVersion, answer.revision)),
  });
  const [step] = published.steps;
  runtime.publish({ practice: { ...published, id: "individual-delivery", questions: published.questions.filter(question => question.id !== "text"),
    grading: { assessment: { ...published.grading.assessment, keyRef: { id: "individual-key", version: 1 } } },
    steps: [{ ...step, submit: { ...step.submit, slots: { answers: { ...step.submit.slots.answers,
      delivery: { mode: "perQuestion", questionSlots: { choice: "position-choice", indexes: "position-indexes" } },
    } } } }],
  }, scoringKey: { id: "individual-key", version: 1, acceptedByQuestion: {
    choice: scoringKey.acceptedByQuestion.choice, indexes: scoringKey.acceptedByQuestion.indexes,
  } } });
  const individually = open("individual-delivery");
  assert.equal(draft(individually, "choice", 2, "yes").revision, 1);
  assert.equal(runtime.read(student, individually.activityId).status, "active");
  writeFileSync(file, JSON.stringify({ group: activityKey.parse(group), individually: activityKey.parse(individually), groupReceipt: groupReceipt.id }));
}

function readCheckpoint() {
  return checkpoint.parse(JSON.parse(readFileSync(file, "utf8")));
}

function raceQuestion(activity: Activity) {
  try {
    runtime.confirmQuestionDelivery(student, activity.activityId, {
      ...key(activity, "question"), slotId, source: "question", questions: [current("choice", 2, 1)],
    });
    console.log("confirmed");
  } catch (error) {
    if (!(error instanceof LearningError) || error.code !== "ALREADY_SUBMITTED") throw error;
    console.log("closed");
  }
}

function raceFinish(activity: Activity) {
  runtime.confirmQuestionDelivery(student, activity.activityId, {
    ...key(activity, "finish"), slotId, source: "finish", questions: [current("choice", 2, 1), current("indexes", 4, 0)],
  });
  console.log("finished");
}

function recover(questionStatus: "confirmed" | "closed") {
  const { group, individually, groupReceipt } = readCheckpoint();
  assert.throws(() => runtime.recoverQuestionDelivery({ ...student, id: "outsider" }, group.activityId, key(group, "whole")),
    { code: "FORBIDDEN" });
  const recovered = runtime.recoverQuestionDelivery(student, group.activityId, key(group, "whole"));
  assert.equal(recovered.receipt.id, groupReceipt);
  assert.deepEqual(recovered.confirmation.questions.map(question => question.value), ["yes", raw, indexes]);
  assert.deepEqual(recovered.evaluation.questions.map(question => question.result), [
    { status: "judged", correct: true }, { status: "needsReview" }, { status: "judged", correct: true },
  ]);

  const end = runtime.recoverQuestionDelivery(student, individually.activityId, key(individually, "finish"));
  assert.equal(end.confirmation.source, "finish");
  const endQuestions = end.confirmation.questions.map(question => [question.questionId, question.value]);
  if (questionStatus === "confirmed") {
    const first = runtime.recoverQuestionDelivery(student, individually.activityId, key(individually, "question"));
    assert.equal(first.receipt.slotId, "position-choice");
    assert.deepEqual(first.confirmation.questions.map(question => question.value), ["yes"]);
    assert.deepEqual(first.evaluation.questions.map(question => question.questionId), ["choice"]);
    assert.deepEqual(endQuestions, [["indexes", null]]);
  } else {
    assert.throws(() => runtime.recoverQuestionDelivery(student, individually.activityId, key(individually, "question")), { code: "CONFIRMATION_NOT_FOUND" });
    assert.deepEqual(endQuestions, [["choice", "yes"], ["indexes", null]]);
  }
  const view = runtime.read(student, individually.activityId);
  assert.ok("questionDeliveries" in view);
  assert.equal(view.status, "completed");
  assert.equal(view.questionDeliveries.length, questionStatus === "confirmed" ? 2 : 1);
  assert.ok(view.questionDeliveries.some(item => item.receipt?.id === end.receipt.id));
  assert.doesNotMatch(JSON.stringify(view), /acceptedByQuestion|requestQuestions|needsReview/);
  using database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS n FROM completions").get()?.n, 2);
  assert.equal(database.prepare("SELECT count(*) AS n FROM evaluation_tasks").get()?.n, questionStatus === "confirmed" ? 3 : 2);
}

try {
  switch (phase) {
    case "write": write(); break;
    case "race-question": raceQuestion(readCheckpoint().individually); break;
    case "race-finish": raceFinish(readCheckpoint().individually); break;
    case "recover":
    case "read-stored": recover(z.enum(["confirmed", "closed"]).parse(process.argv[3])); break;
  }
} finally {
  runtime.close();
}
