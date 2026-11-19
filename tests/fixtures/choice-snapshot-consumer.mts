import { strict as assert } from "node:assert";
import { LearningError, openLearningRuntime } from "learning-kernel";
import type { ChoiceConfirmationInput, ChoiceDraftInput, ChoiceSnapshotRevisionInput, PublicationInput } from "learning-kernel";

const [, , phase, race, outcome] = process.argv;
const author = { role: "student", id: "author" } as const;
const peer = { role: "student", id: "peer" } as const;
const teacher = { role: "reviewer", id: "adviser" } as const;
const open = { protocolVersion: 1, practiceId: "arithmetic", practiceVersion: 1, operationId: "open" } as const;
const evaluator = { id: "classroom-arithmetic", version: 1 };
const publication = {
  scoringKey: { id: "arithmetic-key", version: 1, acceptedChoices: { first: "1", second: "1" } },
  practice: {
    id: open.practiceId, version: 1, formatVersion: 1, title: "Arithmetic",
    goals: { arithmetic: "Practice addition and multiplication" },
    questions: [
      { id: "first", version: 4, prompt: "2 + 3?", options: { "0": "4", "1": "5", "2": "6" } },
      { id: "second", version: 8, prompt: "2 × 4?", options: { "0": "6", "1": "8" } },
    ],
    steps: [{ id: "arithmetic", instructions: "Choose one option per question",
      tool: { id: "single-choice-group", version: 1 }, inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: {
        choices: { type: "oneChoicePerQuestion", source: "questions", targetId: "arithmetic", confirmFromDrafts: { allowUnanswered: true } },
      } }, afterConfirmation: "finish",
    }],
    grading: { assessment: {
      from: { stepId: "arithmetic", slotId: "choices" }, evaluator,
      keyRef: { id: "arithmetic-key", version: 1 }, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
    } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownChoices"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  },
} satisfies PublicationInput;

function execute() {
  const runtime = openLearningRuntime({ databasePath: "snapshots.sqlite",
    choiceEvaluators: [{ ...evaluator, evaluate: ({ choice, acceptedChoice }) => choice === acceptedChoice }],
    authorizeConfirmationRecovery: () => true,
    authorizeChoiceSnapshotRevision: scope => scope.reviewerId === teacher.id && [author.id, peer.id].some(id => id === scope.studentId),
  });
  try {
    runtime.publish(publication);
    const mine = runtime.start(author, race ? { ...open, operationId: `race-${race}` } : open);
    const other = runtime.start(peer, open);
    const selection = (stepAttemptId: string, questionId = "first"): ChoiceDraftInput => ({
      protocolVersion: 1, stepAttemptId, slotId: "choices", questionId, questionVersion: questionId === "first" ? 4 : 8,
      operationId: "choice", baseRevision: 0, choice: questionId === "first" ? "2" : "1",
    });
    const snapshot: ChoiceSnapshotRevisionInput = { protocolVersion: 1, stepAttemptId: mine.stepAttemptId, slotId: "choices", questionId: "first",
      questionVersion: 4, baseRevision: 0, operationId: "fix-first", reason: "Correct a typo",
      prompt: "2 + 4?", options: { "0": "four", "1": "five", "2": "six" }, acceptedChoice: "2",
    };
    const revise = (input: ChoiceSnapshotRevisionInput) => runtime.reviseChoiceSnapshot(teacher, mine.activityId, input);
    const confirm = (student: typeof author | typeof peer, activity: typeof mine, questionVersion: number, revision: number) => {
      const input: ChoiceConfirmationInput = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId: "choices",
        operationId: "confirm",
        questions: [{ questionId: "first", questionVersion, revision, original: { state: "uncollected" } },
          { questionId: "second", questionVersion: 8, revision: 1, original: { state: "uncollected" } }],
      };
      const receipt = runtime.confirmChoices(student, activity.activityId, input);
      assert.deepEqual(runtime.confirmChoices(student, activity.activityId, input), receipt);
      return runtime.recoverChoiceConfirmation(student, activity.activityId, inputKey(input));
    };

    if (phase === "race-prepare") {
      assert.equal(runtime.saveChoiceDraft(author, mine.activityId, selection(mine.stepAttemptId, "second")).revision, 1);
      return;
    }
    if (phase === "race-revise") {
      console.log(compete(() => revise(snapshot), "revised", race === "save" ? "ANSWER_REVISION_CONFLICT" : "ALREADY_SUBMITTED"));
      return;
    }
    if (phase === "race-contend") {
      const contend = race === "save"
        ? () => runtime.saveCurrentChoiceDraft(author, mine.activityId, selection(mine.stepAttemptId))
        : () => confirm(author, mine, 4, 0);
      console.log(compete(contend, "accepted", "QUESTION_REVISION_STALE"));
      return;
    }
    if (phase === "race-recover") {
      const revised = outcome === "revised";
      const wrote = !revised && race === "save";
      const restored = confirm(author, mine, revised ? 5 : 4, revised || wrote ? 1 : 0);
      assert.ok(restored);
      assert.deepEqual(restored.confirmation.questions.map(({ questionVersion, choice }) => [questionVersion, choice]),
        [[revised ? 5 : 4, wrote ? "2" : null], [8, "1"]]);
      assert.deepEqual(restored.choiceDraftChangeCounts.map(item => item.changeCount), [wrote ? 1 : 0, 1]);
      if (revised) assert.equal(revise(snapshot).revision, 1);
      else assert.throws(() => revise(snapshot), { code: "ALREADY_SUBMITTED" });
      return;
    }
    if (phase === "write") {
      const saved = runtime.saveChoiceDraft(author, mine.activityId, selection(mine.stepAttemptId, "second"));
      assert.equal(saved.revision, 1);
      const fixed = revise(snapshot);
      assert.deepEqual([fixed.previousQuestionVersion, fixed.questionVersion, fixed.revision], [4, 5, 1]);
      assert.deepEqual(revise(snapshot), fixed);
      return;
    }
    assert.equal(phase, "recover");
    const fixed = revise(snapshot);
    const next = revise({ ...snapshot, questionVersion: 5, baseRevision: 1, operationId: "fix-again", prompt: "3 + 3?" });
    assert.deepEqual([next.questionVersion, next.revision], [6, 2]);
    assert.deepEqual(revise(snapshot), fixed);
    assert.throws(() => revise({ ...snapshot, reason: "Different intent" }), { code: "OPERATION_CONFLICT" });
    const mineView = runtime.read(author, mine.activityId);
    assert.ok("formatVersion" in mineView);
    const questions = mineView.inputs.questions;
    assert.ok(questions?.from === "questions");
    assert.deepEqual(questions.questions.map(q => [q.version, q.prompt]), [[6, "3 + 3?"], [8, "2 × 4?"]]);
    assert.deepEqual(questions.questions[0]?.options, snapshot.options);
    assert.ok("choiceDrafts" in mineView);
    assert.deepEqual(mineView.choiceDrafts.map(q => [q.questionId, q.revision, q.choice]), [["second", 1, "1"]]);
    assert.ok("choiceSnapshotRevisions" in mineView);
    assert.deepEqual(mineView.choiceSnapshotRevisions, [{ slotId: "choices", questionId: "first", questionVersion: 6, revision: 2 }]);
    assert.doesNotMatch(JSON.stringify(mineView), /acceptedChoice|scoringKey|Correct a typo/);
    assert.throws(() => runtime.saveChoiceDraft(author, mine.activityId, selection(mine.stepAttemptId)), { code: "QUESTION_REVISION_STALE" });
    const intent = { ...selection(mine.stepAttemptId), questionVersion: 6, baseRevision: 2 };
    const chosen = runtime.saveCurrentChoiceDraft(author, mine.activityId, intent);
    assert.deepEqual([chosen.revision, chosen.changeCount], [3, 1]);
    assert.deepEqual(runtime.saveChoiceDraft(author, mine.activityId, intent), chosen);

    runtime.saveChoiceDraft(peer, other.activityId, selection(other.stepAttemptId, "second"));
    runtime.saveChoiceDraft(peer, other.activityId, selection(other.stepAttemptId));
    const peerSnapshot = { ...snapshot, stepAttemptId: other.stepAttemptId };
    assert.throws(() => runtime.reviseChoiceSnapshot(teacher, other.activityId, peerSnapshot), {
      code: "ANSWER_REVISION_CONFLICT", current: { revision: 1 },
    });
    assert.throws(() => runtime.reviseChoiceSnapshot(teacher, other.activityId, { ...peerSnapshot, baseRevision: 1 }),
      { code: "RESPONSE_EVIDENCE_EXISTS" });
    const peerView = runtime.read(peer, other.activityId);
    assert.ok("formatVersion" in peerView);
    const peerQuestions = peerView.inputs.questions;
    assert.ok(peerQuestions?.from === "questions");
    assert.equal(peerQuestions.questions[0]?.prompt, "2 + 3?");
    const graded = confirm(author, mine, 6, 3);
    assert.deepEqual([graded?.evaluation?.questionCount, graded?.evaluation?.correctCount], [2, 2]);
    assert.deepEqual(graded?.choiceDraftChangeCounts, [{ questionId: "first", changeCount: 1 }, { questionId: "second", changeCount: 1 }]);
    assert.equal(confirm(peer, other, 4, 1)?.evaluation?.correctCount, 1);
    assert.throws(() => revise({ ...snapshot, operationId: "closed", questionVersion: 6, baseRevision: 3 }), { code: "ALREADY_SUBMITTED" });
    assert.deepEqual(revise(snapshot), fixed);
  } finally {
    runtime.close();
  }
}

function compete(work: () => unknown, accepted: string, rejected: string) {
  try {
    work();
    return accepted;
  } catch (error) {
    if (error instanceof LearningError && error.code === rejected) return rejected;
    throw error;
  }
}

function inputKey(input: ChoiceConfirmationInput) {
  const { protocolVersion, stepAttemptId, operationId } = input;
  return { protocolVersion, stepAttemptId, operationId };
}

execute();
