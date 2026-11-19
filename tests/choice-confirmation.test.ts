import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ZodError } from "zod";
import { startActivity } from "../src/kernel/activity.ts";
import { evaluatePending } from "../src/kernel/evaluation.ts";
import { readReview } from "../src/kernel/review.ts";
import { manageReading } from "../src/kernel/review-access.ts";
import { saveDraft, submitDraft } from "../src/kernel/submission.ts";
import { readPersonalDraft } from "../src/kernel/work-versions.ts";
import { ChoiceConfirmationConflict, LearningError, openLearningRuntime } from "../src/server.ts";
import type { ChoiceConfirmationInput, PublicationInput, VerifyOriginal } from "../src/server.ts";
import { frozenChoicePublication, practiceId, questionVersions, questions } from "./fixtures/frozen-choice.ts";
import { scenarioDatabase } from "./fixtures/online-reading.ts";

const student = { role: "student", id: "owner" } as const;
const other = { role: "student", id: "other" } as const;
const open = { protocolVersion: 1, operationId: "open", practiceId, practiceVersion: 1 } as const;
const [firstQuestion, secondQuestion] = questions;
assert.ok(firstQuestion && secondQuestion);
const firstId = firstQuestion.id;
const secondId = secondQuestion.id;
const originals = {
  verified: { state: "frozen", documentId: "paper-snapshot", versionId: "sealed-first", sha256: "ab".repeat(32) },
  none: { state: "none" },
  missing: { state: "missing" },
  uncollected: { state: "uncollected" },
} as const;

function declaration(allowUnanswered = true, showChoices = true) {
  const { practice } = frozenChoicePublication;
  const [step] = practice.steps;
  return { practice: { ...practice, grading: {},
    questions: questions.map(question => ({ ...question, version: questionVersions.get(question.id) })),
    steps: [{ ...step, submit: { ...step.submit, slots: {
      answers: { ...step.submit.slots.answers, confirmFromDrafts: { allowUnanswered } },
    } } }],
    policy: { ...practice.policy, student: { ownSubmission: { ...practice.policy.student.ownSubmission,
      fields: showChoices ? ["receipt", "ownChoices"] : ["receipt"],
    } } },
  } } satisfies PublicationInput;
}

function intent(stepAttemptId: string, revisions: readonly number[]): ChoiceConfirmationInput {
  return { protocolVersion: 1, stepAttemptId, operationId: "confirm", slotId: "answers", questions: [
    { questionId: firstId, questionVersion: 1, revision: revisions[0] ?? 0, original: originals.verified },
    { questionId: secondId, questionVersion: 1, revision: revisions[1] ?? 0, original: originals.none },
  ] };
}

function denial(status: number, code: string) {
  return (error: unknown) => error instanceof LearningError && error.status === status && error.code === code;
}

function facts(database: DatabaseSync) {
  return ["works", "work_versions", "choice_draft_operations", "submissions", "completions", "performances", "evaluation_tasks", "automatic_verdicts"]
    .map(table => database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}

function save(runtime: ReturnType<typeof openLearningRuntime>, activityId: string, stepAttemptId: string, questionId: string, choice: string) {
  return runtime.saveChoiceDraft(student, activityId, {
    protocolVersion: 1, operationId: "draft", stepAttemptId, slotId: "answers", questionId, questionVersion: 1, baseRevision: 0, choice,
  });
}

function authorizedView(runtime: ReturnType<typeof openLearningRuntime>, activityId: string) {
  const view = runtime.read(student, activityId);
  assert.ok("formatVersion" in view);
  assert.equal(view.status, "completed");
  return view;
}

test("确认有答、部分答、全空三卷并保留全题分母、四类原稿状态及原回执", t => {
  const path = scenarioDatabase(t);
  let verificationCount = 0;
  let currentVersion = "sealed-first";
  const verifyOriginal: VerifyOriginal = scope => {
    verificationCount++;
    assert.equal(scope.studentId, student.id);
    assert.equal(scope.operationId, "confirm");
    assert.equal(scope.slotId, "answers");
    assert.equal(scope.questionVersion, 1);
    return scope.original.state !== "frozen" || scope.original.versionId === currentVersion;
  };
  const runtime = openLearningRuntime({ databasePath: path, verifyOriginal });
  try {
    runtime.publish(declaration());
    const samples = [
      { choices: ["1", "0"], states: [originals.verified, originals.none] },
      { choices: ["1", null], states: [originals.missing, originals.uncollected] },
      { choices: [null, null], states: [originals.none, originals.none] },
    ] as const;
    using database = new DatabaseSync(path);
    for (const [i, sample] of samples.entries()) {
      const { activityId, stepAttemptId } = runtime.start(student, { ...open, operationId: `open-${i}` });
      const revisions = sample.choices.map((choice, index) => choice === null ? 0 :
        save(runtime, activityId, stepAttemptId, index === 0 ? firstId : secondId, choice).revision);
      const input = { ...intent(stepAttemptId, revisions),
        questions: intent(stepAttemptId, revisions).questions.map((question, index) => ({ ...question,
          original: index === 0 ? sample.states[0] : sample.states[1],
        })),
      };
      const receipt = runtime.confirmChoices(student, activityId, input);
      const countAfterWrite = verificationCount;
      currentVersion = "a-newer-head";
      assert.deepEqual(runtime.confirmChoices(student, activityId, { ...input, questions: input.questions.toReversed() }), receipt);
      assert.equal(verificationCount, countAfterWrite);
      assert.throws(() => runtime.confirmChoices(other, activityId, input), denial(403, "FORBIDDEN"));
      const view = authorizedView(runtime, activityId);
      assert.deepEqual(view.submission, { receipt, confirmation: {
        kind: "choiceConfirmation", questions: input.questions.map((question, index) => ({ ...question, choice: sample.choices[index] })),
      } });
      assert.doesNotMatch(JSON.stringify(view), /acceptedChoices|scoringKey|gradingBasis/);
      const units = database.prepare("SELECT unit_id FROM performances WHERE submission_id = ? ORDER BY unit_id").all(receipt.id);
      assert.deepEqual(units.map(row => row.unit_id), input.questions.flatMap(({ questionId }, index) =>
        sample.choices[index] === null ? [] : [`question:${questionId}`]).toSorted());
    }
    evaluatePending(database);
    assert.deepEqual(facts(database), [6, 6, 3, 3, 3, 3, 0, 0]);
  } finally {
    runtime.close();
  }
});

test("版本、题集合或原稿失配时整单回滚，旧整步写和内置评分不能绕过草稿确认", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path, verifyOriginal: ({ original }) => original.state === "none" });
  try {
    const enabled = declaration();
    assert.throws(() => runtime.publish({ practice: { ...enabled.practice, grading: frozenChoicePublication.practice.grading },
      scoringKey: frozenChoicePublication.scoringKey,
    }), error => error instanceof ZodError && error.issues.some(issue => issue.message.includes("内置评分")));
    const [step] = enabled.practice.steps;
    assert.throws(() => runtime.publish({ practice: { ...enabled.practice,
      steps: [{ ...step, submit: { ...step.submit, purpose: "stepEvidence" } }],
    } }), /要求一个单步整卷单选槽/);
    assert.throws(() => runtime.publish({ practice: { ...enabled.practice, questions } }), /须固定每道题的版本/);
    runtime.publish(enabled);
    const { activityId, stepAttemptId } = runtime.start(student, open);
    assert.equal(save(runtime, activityId, stepAttemptId, firstId, "1").revision, 1);
    using database = new DatabaseSync(path);
    const baseline = facts(database);
    const request = intent(stepAttemptId, [1, 0]);
    const sibling = runtime.start(student, { ...open, operationId: "sibling" });
    assert.throws(() => runtime.confirmChoices(student, activityId, { ...request, stepAttemptId: sibling.stepAttemptId }), denial(403, "FORBIDDEN"));
    const [first, second] = request.questions;
    assert.ok(first && second);
    for (const questions of [[first], [first, first], [first, second, first]]) {
      assert.throws(() => runtime.confirmChoices(student, activityId, { ...request, questions }), denial(422, "INVALID_QUESTION_SET"));
    }
    assert.throws(() => runtime.confirmChoices(student, activityId, { ...request,
      questions: request.questions.map(question => question.questionId === firstId ? { ...question, questionId: "unrelated" } : question),
    }), denial(422, "INVALID_QUESTION_SET"));
    assert.throws(() => runtime.confirmChoices(student, activityId, { ...request,
      questions: request.questions.map(question => ({ ...question, questionVersion: 2 })),
    }), denial(409, "QUESTION_REVISION_STALE"));
    assert.throws(() => runtime.confirmChoices(student, activityId, intent(stepAttemptId, [0, 0])), error =>
      error instanceof ChoiceConfirmationConflict && error.questionId === firstId
      && error.current.revision === 1 && error.current.choice === "1");
    assert.throws(() => runtime.confirmChoices(student, activityId, request), denial(409, "ORIGINAL_NOT_VERIFIED"));
    assert.throws(() => runtime.confirmChoices(student, activityId, { ...request,
      questions: request.questions.map(question => ({ ...question,
        original: question.questionId === firstId ? originals.none : originals.verified,
      })),
    }), denial(409, "ORIGINAL_NOT_VERIFIED"));
    assert.throws(() => runtime.confirmChoices(student, activityId, { ...request,
      questions: request.questions.map(question => ({ ...question, original: originals.uncollected })),
    }), denial(409, "ORIGINAL_NOT_VERIFIED"));
    const malformed = { ...request, questions: request.questions.map(question => ({ ...question,
      original: { state: "frozen", documentId: "paper", body: "bytes" },
    })) };
    assert.throws(() => Reflect.apply(runtime.confirmChoices, runtime, [student, activityId, malformed]), { name: "ZodError" });
    assert.deepEqual(facts(database), baseline);
    assert.equal(runtime.read(student, activityId).status, "active");

    const legacy = saveDraft(database, student.id, activityId, {
      protocolVersion: 1, stepAttemptId, slotId: "answers", choices: { [firstId]: "1", [secondId]: "0" }, references: {},
    });
    assert.throws(() => submitDraft(database, student.id, activityId, {
      protocolVersion: 1, stepAttemptId, slotId: "answers", operationId: "legacy-confirm", draft: legacy.draft,
    }, () => new Date()), denial(422, "INVALID_SLOT"));
    assert.deepEqual(facts(database).slice(3), [0, 0, 0, 0, 0]);
  } finally {
    runtime.close();
  }
});

test("重启按稳定操作找回同一事实，学生受限投影和宿主授权分开核对", t => {
  const path = scenarioDatabase(t);
  let input: ChoiceConfirmationInput;
  let activityId: string;
  let receipt: ReturnType<ReturnType<typeof openLearningRuntime>["confirmChoices"]>;
  const runtime = openLearningRuntime({ databasePath: path, verifyOriginal: () => true });
  try {
    const restrictedPublication = declaration(true, false);
    const { practice } = restrictedPublication;
    runtime.publish({ practice: { ...practice, policy: { ...practice.policy,
      reviewer: { ...practice.policy.reviewer, fields: ["studentChoices"] },
    } } });
    using database = new DatabaseSync(path);
    const started = startActivity(database, student.id, open, () => new Date(), "teacher");
    activityId = started.activityId;
    const draft = save(runtime, activityId, started.stepAttemptId, firstId, "0");
    const active = runtime.read(student, activityId);
    assert.ok("choiceDrafts" in active);
    assert.deepEqual(active.choiceDrafts, [draft]);
    input = intent(started.stepAttemptId, [1, 0]);
    receipt = runtime.confirmChoices(student, activityId, input);
    const restricted = authorizedView(runtime, activityId);
    assert.deepEqual(restricted.submission, { receipt });
    assert.equal("choiceDrafts" in restricted, false);
    assert.doesNotMatch(JSON.stringify(restricted), /choiceDrafts|confirmation|sealed-first|paper-snapshot|acceptedChoices/);
    assert.deepEqual(readReview(database, "teacher", activityId).submissions,
      [{ receipt, answer: { choices: { [firstId]: "0" }, references: {} } }]);
    const confirmedWork = database.prepare("SELECT work_id FROM submissions WHERE id = ?").get(receipt.id)?.work_id;
    assert.ok(typeof confirmedWork === "string");
    assert.throws(() => readPersonalDraft(database, student.id, confirmedWork), denial(403, "FORBIDDEN"));
    assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, inputKey(input)), denial(403, "FORBIDDEN"));
  } finally {
    runtime.close();
  }

  let allowed = false;
  const restarted = openLearningRuntime({ databasePath: path, authorizeConfirmationRecovery: scope => allowed
    && scope.studentId === student.id && scope.activityId === activityId && scope.operationId === input.operationId });
  try {
    assert.deepEqual(restarted.confirmChoices(student, activityId, input), receipt);
    const key = inputKey(input);
    assert.throws(() => restarted.recoverChoiceConfirmation(student, activityId, key), denial(403, "FORBIDDEN"));
    allowed = true;
    const recovered = restarted.recoverChoiceConfirmation(student, activityId, key);
    assert.deepEqual(recovered, { receipt, practice: { id: practiceId, version: 1 },
      choiceDraftChangeCounts: [{ questionId: firstId, changeCount: 1 }, { questionId: secondId, changeCount: 0 }],
      confirmation: { kind: "choiceConfirmation", questions: input.questions.map(question => ({ ...question,
        choice: question.questionId === firstId ? "0" : null,
      })) },
    });
    for (const original of [originals.missing, originals.uncollected, originals.verified]) {
      assert.throws(() => restarted.confirmChoices(student, activityId, { ...input,
        questions: input.questions.map(question => question.questionId === secondId ? { ...question, original } : question),
      }), denial(409, "OPERATION_CONFLICT"));
    }
    assert.throws(() => restarted.confirmChoices(student, activityId, { ...input, slotId: "other" }), denial(409, "OPERATION_CONFLICT"));
    assert.throws(() => restarted.confirmChoices(student, activityId, { ...input, operationId: "duplicate" }), denial(409, "ALREADY_SUBMITTED"));
    assert.throws(() => restarted.recoverChoiceConfirmation(other, activityId, key), denial(403, "FORBIDDEN"));
    using database = new DatabaseSync(path);
    assert.deepEqual(facts(database), [2, 2, 1, 1, 1, 1, 0, 0]);
    assert.deepEqual(manageReading(database, "teacher", activityId, "revokeStudent"), { studentActive: false });
    assert.throws(() => restarted.read(student, activityId), denial(403, "FORBIDDEN"));
    assert.throws(() => restarted.confirmChoices(student, activityId, input), denial(403, "FORBIDDEN"));
    assert.throws(() => restarted.recoverChoiceConfirmation(student, activityId, key), denial(403, "FORBIDDEN"));
  } finally {
    restarted.close();
  }
});

function inputKey({ protocolVersion, stepAttemptId, operationId }: ChoiceConfirmationInput) {
  return { protocolVersion, stepAttemptId, operationId };
}

test("只有显式允许时方可确认空答，默认旧单选槽仍没有逐题确认权限", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path });
  try {
    runtime.publish(frozenChoicePublication);
    const old = runtime.start(student, open);
    assert.throws(() => runtime.confirmChoices(student, old.activityId, intent(old.stepAttemptId, [0, 0])), denial(422, "INVALID_SLOT"));
    using database = new DatabaseSync(path);
    const legacy = saveDraft(database, student.id, old.activityId, {
      protocolVersion: 1, stepAttemptId: old.stepAttemptId, slotId: "answers", choices: { [firstId]: "1", [secondId]: "0" }, references: {},
    });
    submitDraft(database, student.id, old.activityId, {
      protocolVersion: 1, stepAttemptId: old.stepAttemptId, operationId: "confirm", slotId: "answers", draft: legacy.draft,
    }, () => new Date());
    assert.throws(() => runtime.confirmChoices(student, old.activityId, intent(old.stepAttemptId, [0, 0])), denial(409, "OPERATION_CONFLICT"));
    assert.deepEqual(facts(database).slice(6), [1, 0]);
    const strict = declaration(false);
    runtime.publish({ practice: { ...strict.practice, version: 2 } });
    const answerRequired = runtime.start(student, { ...open, practiceVersion: 2, operationId: "strict-open" });
    assert.throws(() => runtime.confirmChoices(student, answerRequired.activityId, intent(answerRequired.stepAttemptId, [0, 0])),
      denial(422, "UNANSWERED_QUESTION"));
    const { activityId, stepAttemptId } = answerRequired;
    save(runtime, activityId, stepAttemptId, firstId, "1");
    save(runtime, activityId, stepAttemptId, secondId, "0");
    const supported = intent(stepAttemptId, [1, 1]);
    assert.throws(() => runtime.confirmChoices(student, activityId, supported), denial(409, "ORIGINAL_NOT_VERIFIED"));
    const legacyEvidence = { ...supported, questions: supported.questions.map(question => ({ ...question, original: originals.uncollected })) };
    const receipt = runtime.confirmChoices(student, activityId, legacyEvidence);
    assert.equal(authorizedView(runtime, activityId).submission?.receipt?.id, receipt.id);
  } finally {
    runtime.close();
  }
});

test("收尾写入失败保留个人草稿，重发后仅确认一次", t => {
  const path = scenarioDatabase(t);
  const runtime = openLearningRuntime({ databasePath: path, verifyOriginal: () => true,
    authorizeConfirmationRecovery: scope => scope.studentId === student.id,
  });
  try {
    runtime.publish(declaration());
    const { activityId, stepAttemptId } = runtime.start(student, open);
    const saved = save(runtime, activityId, stepAttemptId, firstId, "1");
    const request = intent(stepAttemptId, [saved.revision, 0]);
    using database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON completions
      BEGIN SELECT RAISE(ABORT, 'completion unavailable'); END`);
    assert.throws(() => runtime.confirmChoices(student, activityId, request), /completion unavailable/);
    assert.deepEqual(facts(database), [1, 1, 1, 0, 0, 0, 0, 0]);
    assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, inputKey(request)), denial(404, "CONFIRMATION_NOT_FOUND"));
    assert.equal(runtime.read(student, activityId).status, "active");
    database.exec("DROP TRIGGER reject_completion");
    const receipt = runtime.confirmChoices(student, activityId, request);
    assert.deepEqual(runtime.confirmChoices(student, activityId, request), receipt);
    assert.deepEqual(facts(database), [2, 2, 1, 1, 1, 1, 0, 0]);
  } finally {
    runtime.close();
  }
});
