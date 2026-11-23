import { strict as assert } from "node:assert";
import { QuestionDeliveryConflict } from "../src/server.ts";
import type { PublicationInput, QuestionDeliveryInput } from "../src/server.ts";
import { acceptedToken, defaultClauses, outsider, reviewer, scenarioContract, stubEvaluatorRef, stubKeyRef, stubQuestions, stubScoringKey, student } from "./fixtures/contracts/scenario-contract.ts";
import type { Clause, Harness, HandIn, Runtime, ScenarioModule } from "./fixtures/contracts/scenario-contract.ts";

type ReadingPractice = Extract<PublicationInput, { practice: { formatVersion: 1 } }>["practice"];
const slotId = "answers";

type Mode = "whole" | "perQuestion";
type PublicationOptions = Readonly<{ mode?: Mode; version?: number; teacherReview?: readonly string[]; redo?: boolean }>;

function stubPublication(practiceId: string, { mode = "perQuestion", version = 1, teacherReview, redo = false }: PublicationOptions = {}) {
  const delivery = mode === "whole" ? { mode } : { mode, questionSlots: Object.fromEntries(stubQuestions.map(({ id }) => [id, `position-${id}`])) };
  const keyRef = { ...stubKeyRef, version };
  const automaticIds: readonly string[] = stubQuestions.map(({ id }) => id).filter(id => !teacherReview?.includes(id));
  const practice = {
    id: practiceId, version, formatVersion: 1, title: "场景契约", goals: { answer: "作答" },
    questions: stubQuestions.map(question => ({ ...question })),
    steps: [{
      id: "answer", instructions: "作答。", tool: { id: "question-delivery", version: 1 }, inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { [slotId]: {
        type: "questionDelivery", source: "questions", targetId: "answer", confirmFromDrafts: { allowUnanswered: true }, delivery,
      } } },
      afterConfirmation: "finish",
    }],
    grading: { assessment: { from: { stepId: "answer", slotId }, evaluator: stubEvaluatorRef, keyRef, unit: "question",
      effectiveVerdictOrder: ["teacherReview", "automatic"] }, ...teacherReview && { teacherReview: { questionIds: [...teacherReview] } } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] },
      manager: { scope: "assigningTeacher", actions: redo ? ["authorizeRedo"] : [] },
    },
  } satisfies ReadingPractice;
  const scoringKey = { ...keyRef, acceptedByQuestion: Object.fromEntries(Object.entries(stubScoringKey.acceptedByQuestion)
    .filter(([id]) => automaticIds.includes(id))) };
  return { practice, scoringKey } satisfies PublicationInput;
}

function perQuestionPublication(practiceId: string) {
  return stubPublication(practiceId);
}

function handInOneQuestion(harness: Harness, practiceId: string, token: string) {
  const { runtime } = harness;
  const [question] = stubQuestions;
  const activity = runtime.start(student, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId: `start-${practiceId}` });
  const saved = runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion: question.version,
    operationId: "save", baseRevision: 0, value: { token },
  });
  const revision = { questionId: question.id, questionVersion: question.version, revision: saved.revision, original: { state: "uncollected" as const } };
  const input = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, slotId, operationId: "first-question",
    source: "question" as const, questions: [revision] as [typeof revision] };
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  return { activityId: activity.activityId, input, receipt, questionId: question.id, questionVersion: question.version,
    key: { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, operationId: input.operationId } };
}

const submitAndSettle: Clause = (module, harness) => {
  defaultClauses.submit(module, harness);
  const { runtime } = harness;
  runtime.publish(module.publication("settle"));
  const first = module.handIn(harness, "settle", acceptedToken);
  assert.equal(runtime.read(student, first.activityId).status, "active");
  const [, second] = stubQuestions;
  const saved = runtime.saveQuestionDeliveryDraft(student, first.activityId, {
    protocolVersion: 1, stepAttemptId: first.key.stepAttemptId, slotId, questionId: second.id, questionVersion: second.version,
    operationId: "save-second", baseRevision: 0, value: { token: "wrong" },
  });
  const finish = { protocolVersion: 1 as const, stepAttemptId: first.key.stepAttemptId, slotId, operationId: "settle", source: "finish" as const,
    questions: stubQuestions.map(({ id, version }) => ({ questionId: id, questionVersion: version, revision: id === second.id ? saved.revision : 0,
      original: { state: "uncollected" as const } })) };
  const settled = runtime.confirmQuestionDelivery(student, first.activityId, finish);
  runtime.evaluatePending();
  const recovered = runtime.recoverQuestionDelivery(student, first.activityId, { protocolVersion: 1, stepAttemptId: first.key.stepAttemptId,
    operationId: finish.operationId });
  assert.deepEqual(recovered.receipt, settled);
  assert.deepEqual(recovered.confirmation.questions.map(({ questionId, value }) => ({ questionId, value })),
    [{ questionId: second.id, value: { token: "wrong" } }]);
  assert.ok(recovered.evaluation.status === "evaluated");
  assert.deepEqual(recovered.evaluation.questions.map(({ questionId, result }) => ({ questionId, result })),
    [{ questionId: second.id, result: { status: "judged", correct: false } }]);
  assert.equal(runtime.read(student, first.activityId).status, "completed");
  assert.throws(() => runtime.confirmQuestionDelivery(student, first.activityId, { ...finish, operationId: "settle-again" }),
    { status: 409, code: "ALREADY_SUBMITTED" });
};


const forbidden = { status: 403, code: "FORBIDDEN" };
const [firstQuestion, secondQuestion] = stubQuestions;
type StubQuestion = (typeof stubQuestions)[number];
type Started = Readonly<{ activityId: string; stepAttemptId: string }>;

function saveDraft(runtime: Runtime, activity: Started, question: StubQuestion, token: string, baseRevision = 0, operationId = `save-${question.id}`) {
  return runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion: question.version,
    operationId, baseRevision, value: { token },
  });
}

function revisionOf(question: StubQuestion, revision: number) {
  return { questionId: question.id, questionVersion: question.version, revision, original: { state: "uncollected" as const } };
}

function confirmOne(runtime: Runtime, activity: Started, question: StubQuestion, revision: number, operationId: string): HandIn {
  const input = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, slotId, operationId, source: "question" as const,
    questions: [revisionOf(question, revision)] } satisfies QuestionDeliveryInput;
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  return { activityId: activity.activityId, input, receipt, questionId: question.id, questionVersion: question.version,
    key: { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, operationId } };
}

function recoveryKey({ stepAttemptId }: Started, operationId: string) {
  return { protocolVersion: 1 as const, stepAttemptId, operationId };
}

const switchingPractice = "switching";
function openSwitchable(harness: Harness) {
  harness.runtime.publish(stubPublication(switchingPractice, { mode: "whole", version: 1 }));
  harness.runtime.publish(stubPublication(switchingPractice, { mode: "perQuestion", version: 2 }));
  const request = { protocolVersion: 1, practiceId: switchingPractice, practiceVersion: 1, operationId: "open-switching" } as const;
  return { request, activity: harness.runtime.prepare(student, request) };
}

function switchCommand(activity: Started, expectedPracticeVersion: number, practiceVersion: number, operationId: string) {
  return { protocolVersion: 1, intent: "questionDeliveryMode", stepAttemptId: activity.stepAttemptId,
    expectedPracticeVersion, practiceVersion, operationId } as const;
}

const g32: Partial<Record<"submit" | "authorize" | "undo", Clause>> = {
  submit(_module, harness) {
    const { runtime } = harness;
    const { request, activity } = openSwitchable(harness);
    assert.deepEqual(runtime.prepare(student, request), activity);
    assert.deepEqual(runtime.start(student, request), activity);
    assert.throws(() => runtime.prepare(student, { ...request, practiceVersion: 2 }), { status: 409, code: "OPERATION_CONFLICT" });
    const draft = saveDraft(runtime, activity, firstQuestion, acceptedToken);
    const command = switchCommand(activity, 1, 2, "to-per-question");
    const switched = runtime.replacePreparedActivityVersion(student, activity.activityId, command);
    assert.equal(switched.activityId, activity.activityId);
    assert.equal(switched.practiceVersion, 2);
    assert.notEqual(switched.stepAttemptId, activity.stepAttemptId);
    assert.deepEqual(runtime.replacePreparedActivityVersion(student, activity.activityId, command), switched);
    harness.reopen();
    assert.deepEqual(harness.runtime.replacePreparedActivityVersion(student, activity.activityId, command), switched);
    const moved = harness.runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
      protocolVersion: 1, stepAttemptId: switched.stepAttemptId, slotId, questionId: firstQuestion.id, questionVersion: firstQuestion.version,
      operationId: `save-${firstQuestion.id}`, baseRevision: 0, value: { token: acceptedToken },
    }, "replayLatestOnly");
    assert.deepEqual(moved, draft);
    const handed = confirmOne(harness.runtime, switched, firstQuestion, draft.revision, "first-after-switch");
    assert.equal(handed.receipt.slotId, `position-${firstQuestion.id}`);
    harness.runtime.evaluatePending();
    const recovered = harness.runtime.recoverQuestionDelivery(student, activity.activityId, handed.key);
    assert.ok(recovered.evaluation.status === "evaluated");
    assert.equal(recovered.evaluation.correctCount, 1);
    assert.throws(() => harness.runtime.replacePreparedActivityVersion(student, activity.activityId,
      switchCommand(switched, 2, 1, "back-after-delivery")), { status: 409, code: "ACTIVITY_ALREADY_STARTED" });
  },

  authorize(_module, harness) {
    const { runtime } = harness;
    const { request, activity } = openSwitchable(harness);
    assert.equal(runtime.read(student, activity.activityId).activityId, activity.activityId);
    assert.throws(() => runtime.read(outsider, activity.activityId), forbidden);
    saveDraft(runtime, activity, firstQuestion, acceptedToken);
    const command = switchCommand(activity, 1, 2, "to-per-question");
    assert.throws(() => runtime.replacePreparedActivityVersion(outsider, activity.activityId, command), forbidden);
    assert.notEqual(runtime.prepare(outsider, request).activityId, activity.activityId);
    const switched = runtime.replacePreparedActivityVersion(student, activity.activityId, command);
    assert.throws(() => saveDraft(runtime, activity, firstQuestion, acceptedToken), forbidden);
    assert.equal(saveDraft(runtime, switched, firstQuestion, "after-switch", 1, "revise-after-switch").revision, 2);
    assert.throws(() => runtime.replacePreparedActivityVersion(student, activity.activityId,
      { ...command, operationId: "stale-switch" }), { status: 409, code: "ACTIVITY_VERSION_CONFLICT" });
  },

  undo(_module, harness) {
    const { runtime } = harness;
    const { activity } = openSwitchable(harness);
    saveDraft(runtime, activity, firstQuestion, acceptedToken);
    const before = runtime.read(student, activity.activityId);
    const forward = runtime.replacePreparedActivityVersion(student, activity.activityId, switchCommand(activity, 1, 2, "forward"));
    const back = runtime.replacePreparedActivityVersion(student, activity.activityId, switchCommand(forward, 2, 1, "back"));
    assert.equal(back.practiceVersion, 1);
    assert.notEqual(back.stepAttemptId, forward.stepAttemptId);
    assert.deepEqual(runtime.read(student, activity.activityId), { ...before, stepAttemptId: back.stepAttemptId });
    const whole = { protocolVersion: 1 as const, stepAttemptId: back.stepAttemptId, slotId, operationId: "whole", source: "whole" as const,
      questions: [revisionOf(firstQuestion, 1), revisionOf(secondQuestion, 0)] } satisfies QuestionDeliveryInput;
    const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, whole);
    assert.equal(receipt.slotId, slotId);
    assert.throws(() => runtime.confirmQuestionDelivery(student, activity.activityId, { ...whole, stepAttemptId: forward.stepAttemptId,
      operationId: "stale" }), forbidden);
  },
};

const draftsPractice = "drafts";
const g33: Partial<Record<"submit" | "authorize", Clause>> = {
  submit(_module, harness) {
    const { runtime } = harness;
    runtime.publish(stubPublication(draftsPractice, { mode: "whole" }));
    const activity = runtime.start(student, { protocolVersion: 1, practiceId: draftsPractice, practiceVersion: 1, operationId: "open-drafts" });
    const first = saveDraft(runtime, activity, firstQuestion, "draft-1");
    assert.equal(first.revision, 1);
    assert.deepEqual(saveDraft(runtime, activity, firstQuestion, "draft-1"), first);
    assert.throws(() => saveDraft(runtime, activity, firstQuestion, "draft-other"), error =>
      error instanceof QuestionDeliveryConflict && error.code === "OPERATION_CONFLICT");
    const second = saveDraft(runtime, activity, firstQuestion, acceptedToken, 1, "revise");
    assert.equal(second.revision, 2);
    assert.throws(() => saveDraft(runtime, activity, firstQuestion, "late", 1, "late-write"), error =>
      error instanceof QuestionDeliveryConflict && error.code === "ANSWER_REVISION_CONFLICT" && error.current.revision === 2);
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
      protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: firstQuestion.id, questionVersion: firstQuestion.version,
      operationId: "malformed", baseRevision: 2, value: { token: 1 },
    }), { status: 422, code: "INVALID_RESPONSE" });
    assert.throws(() => runtime.saveQuestionDeliveryDraft(student, activity.activityId, {
      protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: firstQuestion.id, questionVersion: firstQuestion.version + 1,
      operationId: "stale-version", baseRevision: 2, value: { token: acceptedToken },
    }), { status: 409, code: "QUESTION_REVISION_STALE" });
    harness.reopen();
    const view = harness.runtime.read(student, activity.activityId);
    assert.ok("questionDeliveryDrafts" in view);
    assert.deepEqual(view.questionDeliveryDrafts, [second]);
    const whole = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, slotId, operationId: "whole", source: "whole" as const,
      questions: [revisionOf(firstQuestion, 2), revisionOf(secondQuestion, 0)] } satisfies QuestionDeliveryInput;
    harness.runtime.confirmQuestionDelivery(student, activity.activityId, whole);
    assert.throws(() => saveDraft(harness.runtime, activity, firstQuestion, "after", 2, "after-confirm"), { status: 409, code: "ALREADY_SUBMITTED" });
    assert.equal(harness.evaluations, 0);
  },

  authorize(_module, harness) {
    const { runtime } = harness;
    runtime.publish(stubPublication(draftsPractice, { mode: "whole" }));
    const activity = runtime.start(student, { protocolVersion: 1, practiceId: draftsPractice, practiceVersion: 1, operationId: "open-drafts" });
    const saved = saveDraft(runtime, activity, firstQuestion, acceptedToken);
    assert.equal(saved.revision, 1);
    assert.throws(() => runtime.saveQuestionDeliveryDraft(outsider, activity.activityId, {
      protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: firstQuestion.id, questionVersion: firstQuestion.version,
      operationId: "intrude", baseRevision: 1, value: { token: "intruder" },
    }), forbidden);
    assert.throws(() => runtime.read(outsider, activity.activityId), forbidden);
    const view = runtime.read(student, activity.activityId);
    assert.ok("questionDeliveryDrafts" in view);
    assert.deepEqual(view.questionDeliveryDrafts, [saved]);
    assert.doesNotMatch(JSON.stringify(view), /acceptedToken|acceptedByQuestion|contract-stub-key/);
  },
};

const lessonPractice = "lesson";
function openLesson(harness: Harness, operationId = "open-lesson") {
  harness.runtime.publish(stubPublication(lessonPractice));
  return harness.runtime.start(student, { protocolVersion: 1, practiceId: lessonPractice, practiceVersion: 1, operationId });
}

function completeLesson(harness: Harness, activity: Started, tokens: readonly [string, string] = [acceptedToken, "wrong"]) {
  const { runtime } = harness;
  const handed = stubQuestions.map((question, index) => {
    const draft = saveDraft(runtime, activity, question, tokens[index] ?? acceptedToken);
    return confirmOne(runtime, activity, question, draft.revision, `lesson-${question.id}`);
  });
  runtime.evaluatePending();
  return handed;
}

const g46: Record<"submit" | "authorize" | "failure" | "undo", Clause> = {
  submit(_module, harness) {
    const { runtime } = harness;
    const activity = openLesson(harness);
    assert.deepEqual(openLesson(harness), activity);
    const [first] = completeLesson(harness, activity);
    assert.ok(first);
    const instant = runtime.recoverQuestionDelivery(student, activity.activityId, first.key);
    assert.ok(instant.evaluation.status === "evaluated");
    assert.deepEqual(instant.evaluation.questions.map(({ result }) => result), [{ status: "judged", correct: true }]);
    assert.equal(runtime.read(student, activity.activityId).status, "completed");
    const restart = openLesson(harness, "restart");
    assert.notEqual(restart.activityId, activity.activityId);
    assert.deepEqual(openLesson(harness, "restart"), restart);
    assert.equal(runtime.read(student, restart.activityId).status, "active");
    const [again] = completeLesson(harness, restart, ["wrong", acceptedToken]);
    assert.ok(again);
    const retried = runtime.recoverQuestionDelivery(student, restart.activityId, again.key);
    assert.ok(retried.evaluation.status === "evaluated");
    assert.deepEqual(retried.evaluation.questions.map(({ result }) => result), [{ status: "judged", correct: false }]);
  },

  authorize(_module, harness) {
    const { runtime } = harness;
    assert.throws(() => runtime.publish(stubPublication("lesson-redo", { redo: true })), /原值确认的评阅只声明/);
    const activity = openLesson(harness);
    const [first] = completeLesson(harness, activity);
    assert.ok(first);
    assert.throws(() => runtime.redo(student, activity.activityId, { protocolVersion: 1, operationId: "restart" }),
      { status: 409, code: "REDO_NOT_AVAILABLE" });
    const restart = openLesson(harness, "restart");
    assert.throws(() => runtime.read(outsider, restart.activityId), forbidden);
    assert.throws(() => runtime.recoverQuestionDelivery(outsider, activity.activityId, first.key), forbidden);
    const draft = saveDraft(runtime, restart, firstQuestion, acceptedToken);
    const input = { protocolVersion: 1 as const, stepAttemptId: restart.stepAttemptId, slotId, operationId: "restart-first", source: "question" as const,
      questions: [revisionOf(firstQuestion, draft.revision)] } satisfies QuestionDeliveryInput;
    assert.throws(() => runtime.confirmQuestionDelivery(outsider, restart.activityId, input), forbidden);
    assert.throws(() => runtime.confirmQuestionDelivery(student, restart.activityId, { ...input, stepAttemptId: activity.stepAttemptId }), forbidden);
    assert.equal(runtime.confirmQuestionDelivery(student, restart.activityId, input).slotId, `position-${firstQuestion.id}`);
  },

  failure(_module, harness) {
    const { runtime } = harness;
    const activity = openLesson(harness);
    harness.evaluatorBroken = true;
    const draft = saveDraft(runtime, activity, firstQuestion, acceptedToken);
    const handed = confirmOne(runtime, activity, firstQuestion, draft.revision, "lesson-first");
    const scope = { submissionId: handed.receipt.id };
    for (const expected of [{ retrying: 1, failed: 0 }, { retrying: 1, failed: 0 }, { retrying: 0, failed: 1 }]) {
      assert.deepEqual(runtime.evaluatePending(scope), { evaluated: 0, deferred: 0, ...expected });
    }
    harness.evaluatorBroken = false;
    assert.deepEqual(runtime.recoverQuestionDelivery(student, activity.activityId, handed.key).evaluation,
      { status: "failed", evaluator: stubEvaluatorRef });
    const second = saveDraft(runtime, activity, secondQuestion, acceptedToken);
    const next = confirmOne(runtime, activity, secondQuestion, second.revision, "lesson-second");
    runtime.evaluatePending();
    const recovered = runtime.recoverQuestionDelivery(student, activity.activityId, next.key);
    assert.ok(recovered.evaluation.status === "evaluated");
    assert.equal(recovered.evaluation.correctCount, 1);
    assert.equal(runtime.read(student, activity.activityId).status, "completed");
  },

  undo(_module, harness) {
    const { runtime } = harness;
    const activity = openLesson(harness);
    const originals = completeLesson(harness, activity);
    const before = originals.map(({ key }) => runtime.recoverQuestionDelivery(student, activity.activityId, key));
    const originalView = runtime.read(student, activity.activityId);
    const restart = openLesson(harness, "restart");
    const freshView = runtime.read(student, restart.activityId);
    assert.ok("questionDeliveries" in freshView);
    assert.deepEqual(freshView.questionDeliveries, []);
    completeLesson(harness, restart, ["wrong", "wrong"]);
    assert.deepEqual(originals.map(({ key }) => runtime.recoverQuestionDelivery(student, activity.activityId, key)), before);
    assert.deepEqual(runtime.read(student, activity.activityId), originalView);
    assert.throws(() => runtime.recoverQuestionDelivery(student, restart.activityId, recoveryKey(activity, "lesson-first")), forbidden);
  },
};

const queuePractice = "queue";
function handInQueue(harness: Harness, token = acceptedToken) {
  const { runtime } = harness;
  runtime.publish(stubPublication(queuePractice, { mode: "whole", teacherReview: [secondQuestion.id] }));
  const activity = runtime.start(student, { protocolVersion: 1, practiceId: queuePractice, practiceVersion: 1, operationId: "open-queue" });
  const revisions = stubQuestions.map(question => revisionOf(question, saveDraft(runtime, activity, question, token).revision));
  const input = { protocolVersion: 1 as const, stepAttemptId: activity.stepAttemptId, slotId, operationId: "hand-in", source: "whole" as const,
    questions: revisions } satisfies QuestionDeliveryInput;
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  return { activityId: activity.activityId, input, receipt, key: recoveryKey(activity, input.operationId) };
}
type Queue = ReturnType<typeof handInQueue>;

function queue(harness: Harness, { activityId, key }: Queue) {
  return harness.runtime.readQuestionDeliveryReview(reviewer, activityId, key, "verdicts");
}

function slot(question: StubQuestion, revision: number, status: string) {
  return { questionId: question.id, questionVersion: question.version, revision, status };
}

function automaticSlot(question: StubQuestion, revision: number, correct: boolean) {
  return { ...slot(question, revision, "judged"), automatic: { correct, valid: true }, effective: { source: "automatic", correct } };
}

function mark(harness: Harness, handed: Queue, question: StubQuestion, operationId: string, expectedRevision: number, correct: boolean) {
  return harness.runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key, {
    protocolVersion: 1, submissionId: handed.receipt.id, targetId: "answer", questionId: question.id, operationId, expectedRevision,
    action: "override", correct, reason: "教师判定",
  });
}

function withdraw(harness: Harness, handed: Queue, question: StubQuestion, operationId: string, expectedRevision: number, withdrawId: string) {
  return harness.runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key, {
    protocolVersion: 1, submissionId: handed.receipt.id, targetId: "answer", questionId: question.id, operationId, expectedRevision,
    action: "withdraw", withdrawId, reason: "撤回判定",
  });
}

const g48: Record<"submit" | "authorize" | "failure" | "undo", Clause> = {
  submit(_module, harness) {
    const handed = handInQueue(harness);
    assert.deepEqual(queue(harness, handed).questions, [slot(firstQuestion, 0, "pendingEvaluation"), slot(secondQuestion, 0, "needsReview")]);
    assert.deepEqual(harness.runtime.confirmQuestionDelivery(student, handed.activityId, handed.input), handed.receipt);
    harness.runtime.evaluatePending();
    const settled = [automaticSlot(firstQuestion, 0, true), slot(secondQuestion, 0, "needsReview")];
    assert.deepEqual(queue(harness, handed).questions, settled);
    const marked = mark(harness, handed, secondQuestion, "mark-second", 0, true);
    assert.deepEqual(mark(harness, handed, secondQuestion, "mark-second", 0, true), marked);
    assert.throws(() => mark(harness, handed, secondQuestion, "mark-second", 0, false), { code: "OPERATION_CONFLICT" });
    harness.reopen();
    assert.deepEqual(queue(harness, handed).questions, [settled[0],
      { ...slot(secondQuestion, 1, "judged"), effective: { source: "teacherReview", id: marked.id, correct: true } }]);
    assert.equal(harness.evaluations, 1);
  },

  authorize(_module, harness) {
    const handed = handInQueue(harness);
    harness.runtime.evaluatePending();
    assert.equal(queue(harness, handed).questions.length, 2);
    mark(harness, handed, secondQuestion, "mark-second", 0, false);
    const own = harness.runtime.recoverQuestionDelivery(student, handed.activityId, handed.key, "declared");
    assert.deepEqual(own.receipt, handed.receipt);
    assert.doesNotMatch(JSON.stringify({ own, view: harness.runtime.read(student, handed.activityId) }),
      /教师判定|"source":"teacherReview"|acceptedToken|contract-stub-key/);
    assert.throws(() => harness.runtime.readQuestionDeliveryReview({ ...reviewer, id: "other-reviewer" }, handed.activityId, handed.key, "verdicts"),
      forbidden);
    harness.reviewAllowed = false;
    assert.throws(() => queue(harness, handed), forbidden);
    assert.throws(() => mark(harness, handed, secondQuestion, "mark-again", 1, true), forbidden);
  },

  failure(_module, harness) {
    harness.evaluatorBroken = true;
    const handed = handInQueue(harness);
    const scope = { submissionId: handed.receipt.id };
    for (let attempt = 0; attempt < 3; attempt += 1) harness.runtime.evaluatePending(scope);
    harness.evaluatorBroken = false;
    assert.deepEqual(harness.runtime.evaluatePending(scope), { evaluated: 0, retrying: 0, failed: 0, deferred: 0 });
    assert.deepEqual(queue(harness, handed).questions, [slot(firstQuestion, 0, "evaluationFailed"), slot(secondQuestion, 0, "needsReview")]);
    const first = mark(harness, handed, firstQuestion, "manual-first", 0, true);
    const second = mark(harness, handed, secondQuestion, "manual-second", 0, false);
    assert.deepEqual(queue(harness, handed).questions, [
      { ...slot(firstQuestion, 1, "judged"), effective: { source: "teacherReview", id: first.id, correct: true } },
      { ...slot(secondQuestion, 1, "judged"), effective: { source: "teacherReview", id: second.id, correct: false } },
    ]);
    assert.equal(harness.evaluations, 3);
  },

  undo(_module, harness) {
    const handed = handInQueue(harness, "wrong");
    harness.runtime.evaluatePending();
    const before = queue(harness, handed).questions;
    assert.deepEqual(before, [automaticSlot(firstQuestion, 0, false), slot(secondQuestion, 0, "needsReview")]);
    const first = mark(harness, handed, firstQuestion, "amend-first", 0, true);
    const second = mark(harness, handed, secondQuestion, "amend-second", 0, true);
    assert.throws(() => withdraw(harness, handed, secondQuestion, "stale-undo", 0, second.id), { code: "VERDICT_CONFLICT" });
    withdraw(harness, handed, firstQuestion, "undo-first", 1, first.id);
    withdraw(harness, handed, secondQuestion, "undo-second", 1, second.id);
    assert.deepEqual(queue(harness, handed).questions, [automaticSlot(firstQuestion, 2, false), slot(secondQuestion, 2, "needsReview")]);
  },
};

const wrongPracticeSources = new WeakMap<Harness, Readonly<{ activityId: string; key: ReturnType<typeof recoveryKey>; recovered: unknown }>>();

function handInWrongPractice(harness: Harness, practiceId: string, token: string) {
  const { runtime } = harness;
  const broken = harness.evaluatorBroken;
  harness.evaluatorBroken = false;
  runtime.publish(stubPublication(`${practiceId}-source`, { mode: "whole" }));
  const source = runtime.start(student, { protocolVersion: 1, practiceId: `${practiceId}-source`, practiceVersion: 1, operationId: "open-source" });
  const whole = { protocolVersion: 1 as const, stepAttemptId: source.stepAttemptId, slotId, operationId: "source", source: "whole" as const,
    questions: stubQuestions.map(question => revisionOf(question, saveDraft(runtime, source, question, "wrong").revision)) } satisfies QuestionDeliveryInput;
  runtime.confirmQuestionDelivery(student, source.activityId, whole);
  runtime.evaluatePending();
  const key = recoveryKey(source, whole.operationId);
  wrongPracticeSources.set(harness, { activityId: source.activityId, key, recovered: runtime.recoverQuestionDelivery(student, source.activityId, key) });
  harness.evaluations = 0;
  harness.evaluatorBroken = broken;
  return handInOneQuestion(harness, practiceId, token);
}

function sourceUnchanged(clause: Clause): Clause {
  return (module, harness) => {
    clause(module, harness);
    const source = wrongPracticeSources.get(harness);
    assert.ok(source);
    harness.studentRecovery = true;
    assert.deepEqual(harness.runtime.recoverQuestionDelivery(student, source.activityId, source.key), source.recovered);
    assert.equal(harness.runtime.read(student, source.activityId).status, "completed");
  };
}

const g50 = {
  submit: sourceUnchanged(defaultClauses.submit),
  authorize: sourceUnchanged(defaultClauses.authorize),
  failure: sourceUnchanged(defaultClauses.failure),
  undo: sourceUnchanged(defaultClauses.undo),
};

const modules: readonly ScenarioModule[] = [
  { group: "G35", title: "逐题交付：逐题提交与分段结算", publication: perQuestionPublication, handIn: handInOneQuestion,
    clauses: { submit: submitAndSettle } },
  { group: "G32", title: "作答活动：激活、课程开卷与整卷/逐题切换", publication: perQuestionPublication, handIn: handInOneQuestion,
    clauses: g32, notApplicable: { failure: "切换不触发评估" } },
  { group: "G33", title: "作答草稿保存与教师修正", publication: perQuestionPublication, handIn: handInOneQuestion,
    clauses: g33, notApplicable: { failure: "草稿不评估", undo: "草稿按修订覆盖，无撤销语义" } },
  { group: "G46", title: "讲练轮次", publication: perQuestionPublication, handIn: handInOneQuestion, clauses: g46 },
  { group: "G48", title: "教师待批与改判/清除", publication: perQuestionPublication, handIn: handInOneQuestion, clauses: g48 },
  { group: "G50", title: "错题本与错题重练", publication: perQuestionPublication, handIn: handInWrongPractice, clauses: g50 },
];

for (const module of modules) scenarioContract(module);
