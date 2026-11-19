import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { openLearningRuntime } from "learning-kernel";
import type { ChoiceConfirmationInput, ChoiceEvaluator, PublicationInput } from "learning-kernel";
import { z } from "zod";

const answers = z.array(z.object({ index: z.int() }).nullable());
const frozen = z.object({ cases: z.object({ complete: answers, partial: answers, empty: answers }), questions: z.array(z.object({
  id: z.string(), version: z.number(), stemMd: z.string(), options: z.array(z.string()), answers: z.object({ index: z.number() }),
})) }).parse(JSON.parse(readFileSync("frozen-choice.json", "utf8")));
const evaluator = { id: "host-frozen-choice", version: 1 };
const practiceId = "host-graded-exam";
const key = { id: practiceId, version: 1 };
const publication: PublicationInput = {
  scoringKey: { ...key, acceptedChoices: Object.fromEntries(frozen.questions.map(question => [question.id, String(question.answers.index)])) },
  practice: {
    id: practiceId, version: 1, formatVersion: 1, title: "两道冻结题",
    goals: { score: "逐题判定" },
    questions: frozen.questions.map(question => ({
      id: question.id, version: question.version, prompt: question.stemMd,
      options: Object.fromEntries(question.options.map((option, index) => [String(index), option])),
    })),
    steps: [{
      id: "answer", instructions: "每题选一个选项。", tool: { id: "single-choice-group", version: 1 },
      inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { answers: {
        type: "oneChoicePerQuestion", source: "questions", targetId: "score", confirmFromDrafts: { allowUnanswered: true },
      } } },
      afterConfirmation: "finish",
    }],
    grading: { assessment: {
      evaluator, keyRef: key, from: { stepId: "answer", slotId: "answers" }, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
    } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  },
};

const [, , phase] = process.argv;
const scenarios = ["complete", "empty", "partial"] as const;
const student = { role: "student", id: "grader-owner" } as const;
let calls = 0;
let scope: { activityId: string; stepAttemptId: string } | undefined;
const evaluate: ChoiceEvaluator = input => {
  calls += 1;
  if (phase === "crash" && calls === 2) process.exit(47);
  assert.ok(scope);
  assert.equal(input.activityId, scope.activityId);
  assert.equal(input.stepAttemptId, scope.stepAttemptId);
  assert.equal(input.slotId, "answers");
  assert.deepEqual(input.practice, { id: practiceId, version: 1 });
  const question = frozen.questions.find(question => question.id === input.questionId);
  assert.ok(question);
  assert.equal(input.questionVersion, question.version);
  assert.equal(input.acceptedChoice, String(question.answers.index));
  return input.choice !== null && input.choice !== input.acceptedChoice;
};
const runtime = openLearningRuntime({
  databasePath: "scored.sqlite",
  authorizeConfirmationRecovery: requested => requested.studentId === student.id && requested.operationId === "hand-in",
  choiceEvaluators: [{ ...evaluator, version: phase === "wrong-version" ? 2 : 1, evaluate }],
});
try {
  if (phase === "init") runtime.publish(publication);
  for (const example of scenarios) {
    const opened = runtime.start(student, { protocolVersion: 1, operationId: example, practiceId, practiceVersion: 1 });
    const { activityId, stepAttemptId } = opened;
    scope = opened;
    const choices = frozen.cases[example];
    const key = { protocolVersion: 1, stepAttemptId, operationId: "hand-in" } as const;
    const input: ChoiceConfirmationInput = {
      ...key, slotId: "answers", questions: frozen.questions.map((question, index) => {
        const answer = choices[index];
        const revision = answer ? 1 : 0;
        if (phase === "init" && answer) {
          const saved = runtime.saveChoiceDraft(student, activityId, {
            protocolVersion: 1, stepAttemptId, slotId: "answers", questionId: question.id,
            questionVersion: question.version, choice: String(answer.index),
          });
          assert.equal(saved.revision, revision);
        }
        return { questionId: question.id, questionVersion: question.version, revision, original: { state: "uncollected" } };
      }),
    };
    const receipt = runtime.confirmChoices(student, activityId, input);
    assert.deepEqual(runtime.confirmChoices(student, activityId, input), receipt);
    const view = runtime.read(student, activityId);
    assert.equal(view.status, "completed");
    assert.ok("formatVersion" in view);
    assert.deepEqual(view.submission, { receipt });
    assert.doesNotMatch(JSON.stringify(view), /acceptedChoice|scoringKey|correctCount|"correct"/);
    assert.throws(() => runtime.recoverChoiceConfirmation({ ...student, id: "another" }, activityId, key), { code: "FORBIDDEN" });
    if (phase === "init") continue;
    if (phase === "wrong-version") {
      assert.throws(() => runtime.recoverChoiceConfirmation(student, activityId, key), { code: "EVALUATOR_UNAVAILABLE", status: 503 });
      continue;
    }
    const restored = runtime.recoverChoiceConfirmation(student, activityId, key);
    assert.equal(phase, "recover");
    assert.deepEqual(restored.receipt, receipt);
    assert.deepEqual(restored.confirmation.questions.map(({ choice }) => choice), choices.map(answer => answer ? String(answer.index) : null));
    assert.deepEqual(restored.evaluation, {
      evaluator, questionCount: 2, correctCount: example === "complete" ? 1 : 0,
      questions: frozen.questions.map((question, index) => ({
        questionId: question.id, questionVersion: question.version, correct: example === "complete" && index === 1,
      })),
    });
    assert.doesNotMatch(JSON.stringify(restored), /acceptedChoice|scoringKey/);
    assert.deepEqual(runtime.recoverChoiceConfirmation(student, activityId, key), restored);
  }
  if (phase === "recover") console.log(calls);
  else assert.equal(calls, 0);
} finally {
  runtime.close();
}
