import { strict as assert } from "node:assert";
import {
  contractPolicy, deliveryInput, deliveryPublication, outsider, override, recoveryKey, reviewer, saveDraft, startFor, student, withdraw,
} from "../fixtures/contracts/delivery.ts";
import type { DeliveryReceipt, Runtime } from "../fixtures/contracts/delivery.ts";
import { pendingToken, scenarioContract, stubKeyFor, stubQuestion } from "../fixtures/contracts/scenario-contract.ts";
import type { StubWorld } from "../fixtures/contracts/scenario-contract.ts";
import type { SelfAssessmentInput } from "../../src/server.ts";

const objective = stubQuestion("q1");
const written = stubQuestion("q2");
const practiceId = "g47";
const forbidden = { status: 403, code: "FORBIDDEN" };
const scoredPolicy = (scoring: "separate" | "countAsCorrect"): typeof contractPolicy => ({
  ...contractPolicy, student: { ...contractPolicy.student, selfAssessment: { scoring } },
});
const declaration = (scoring: "separate" | "countAsCorrect" = "separate") => ({
  id: practiceId, questions: [objective, written], mode: "whole", allowUnanswered: true, policy: scoredPolicy(scoring),
  grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [], selfReview: [written.id] },
} as const);

type Handed = Readonly<{ runtime: Runtime; activityId: string; key: ReturnType<typeof recoveryKey>; receipt: DeliveryReceipt }>;

function handIn(world: StubWorld, values: readonly [string, string] = ["甲", pendingToken], scoring?: "separate" | "countAsCorrect") {
  const runtime = world.open();
  runtime.publish(deliveryPublication(declaration(scoring)));
  const activity = startFor(runtime, practiceId);
  const handed = [objective, written].map((question, index) => ({ question, revision: saveDraft(runtime, activity, question, values[index] ?? "").revision }));
  const input = deliveryInput(activity, "whole", handed, "hand-in");
  const receipt = runtime.confirmQuestionDelivery(student, activity.activityId, input);
  return { runtime, activityId: activity.activityId, key: recoveryKey(input), receipt } satisfies Handed;
}

function assess(handed: Handed, operationId: string, expectedRevision: number, verdict: SelfAssessmentInput["verdict"], questionId = written.id) {
  return handed.runtime.selfAssess(student, handed.activityId, handed.key, { protocolVersion: 1, operationId, questionId, expectedRevision, verdict });
}

function teacherView(handed: Handed) {
  const review = handed.runtime.readQuestionDeliveryReview(reviewer, handed.activityId, handed.key, "verdicts");
  return { counts: review.selfAssessment, self: review.questions.find(({ questionId }) => questionId === written.id) };
}

scenarioContract({
  group: "G47",
  items: {
    submit: {
      title: "交付后学生对自评题自评，记录来源为自评且单列计数；同操作重发取回原回执，换值报冲突；跨开库读回",
      run(world) {
        const handed = handIn(world);
        handed.runtime.evaluatePending();
        const receipt = assess(handed, "self-1", 0, "correct");
        assert.deepEqual(assess(handed, "self-1", 0, "correct"), receipt);
        assert.throws(() => assess(handed, "self-1", 0, "wrong"), { status: 409, code: "OPERATION_CONFLICT" });
        handed.runtime.close();
        const reopened = { ...handed, runtime: world.open() };
        const { counts, self } = teacherView(reopened);
        assert.equal(self?.status, "needsReview");
        assert.deepEqual(self && "selfAssessment" in self && { ...self.selfAssessment, assessedAt: undefined },
          { source: "self", revision: 1, verdict: "correct", assessedAt: undefined });
        assert.deepEqual(counts, {
          scoring: "separate", questionCount: 2, judgedCorrect: 1, judgedWrong: 0, selfAssessedCorrect: 1, selfAssessedWrong: 0, pending: 0, correctCount: 1,
        });
        assert.equal(reopened.runtime.readSelfAssessments(student, handed.activityId, handed.key).questions[0]?.selfAssessment.verdict, "correct");
      },
    },
    authorize: {
      title: "他人不能自评或读自评；自动判定题、未声明自评的练法拒绝自评；教师已判的题拒绝自评",
      run(world) {
        const handed = handIn(world);
        handed.runtime.evaluatePending();
        const input = { protocolVersion: 1, operationId: "intrude", questionId: written.id, expectedRevision: 0, verdict: "correct" } as const;
        assert.throws(() => handed.runtime.selfAssess(outsider, handed.activityId, handed.key, input), forbidden);
        assert.throws(() => handed.runtime.readSelfAssessments(outsider, handed.activityId, handed.key), forbidden);
        assert.throws(() => assess(handed, "objective", 0, "correct", objective.id), { status: 409, code: "SELF_ASSESSMENT_NOT_AVAILABLE" });
        handed.runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key,
          override({ receipt: handed.receipt, questionId: written.id, operationId: "teacher", expectedRevision: 0 }, false));
        assert.throws(() => assess(handed, "late", 0, "correct"), { status: 409, code: "SELF_ASSESSMENT_TEACHER_JUDGED" });
        handed.runtime.publish(deliveryPublication({ ...declaration(), id: "g47-plain", policy: contractPolicy,
          grading: { keys: { q1: stubKeyFor("甲"), q2: stubKeyFor("乙") }, teacherReview: [] } }));
        const plain = startFor(handed.runtime, "g47-plain");
        const draft = saveDraft(handed.runtime, plain, written, pendingToken);
        const plainInput = deliveryInput(plain, "whole", [{ question: objective, revision: 0 }, { question: written, revision: draft.revision }], "plain");
        handed.runtime.confirmQuestionDelivery(student, plain.activityId, plainInput);
        handed.runtime.evaluatePending();
        assert.throws(() => handed.runtime.selfAssess(student, plain.activityId, recoveryKey(plainInput), { ...input, operationId: "plain" }),
          { status: 409, code: "SELF_ASSESSMENT_NOT_AVAILABLE" });
      },
    },
    failure: {
      title: "评估进行中拒绝自评；评估连续失败进入失败终态后仍可自评并计入自评",
      run(world) {
        const handed = handIn(world);
        assert.throws(() => assess(handed, "early", 0, "wrong"), { status: 409, code: "EVALUATION_PENDING" });
        world.failuresLeft = 3;
        for (let attempt = 0; attempt < 3; attempt++) handed.runtime.evaluatePending({ submissionId: handed.receipt.id });
        assert.equal(assess(handed, "after-failure", 0, "wrong").revision, 1);
        const { counts, self } = teacherView(handed);
        assert.equal(self?.status, "evaluationFailed");
        assert.ok(counts && "selfAssessedWrong" in counts);
        assert.equal(counts.selfAssessedWrong, 1);
        assert.equal(counts.pending, 1);
      },
    },
    withdraw: {
      title: "学生清除自评回到待自评；教师改判取代自评，撤销改判后自评重新生效",
      run(world) {
        const handed = handIn(world);
        handed.runtime.evaluatePending();
        assess(handed, "self-1", 0, "correct");
        assert.equal(assess(handed, "clear", 1, null).verdict, null);
        const cleared = teacherView(handed);
        assert.ok(cleared.counts && "pending" in cleared.counts && cleared.self && "selfAssessment" in cleared.self);
        assert.deepEqual([cleared.counts.pending, cleared.counts.selfAssessedCorrect, cleared.self.selfAssessment.verdict], [1, 0, null]);
        assess(handed, "self-2", 2, "correct");
        const marked = handed.runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key,
          override({ receipt: handed.receipt, questionId: written.id, operationId: "teacher", expectedRevision: 0 }, false));
        const superseded = teacherView(handed).counts;
        assert.ok(superseded && "judgedWrong" in superseded);
        assert.deepEqual([superseded.judgedWrong, superseded.selfAssessedCorrect], [1, 0]);
        handed.runtime.writeQuestionDeliveryVerdict(reviewer, handed.activityId, handed.key,
          withdraw({ receipt: handed.receipt, questionId: written.id, operationId: "undo", expectedRevision: 1 }, marked.id));
        const restored = teacherView(handed).counts;
        assert.ok(restored && "selfAssessedCorrect" in restored);
        assert.deepEqual([restored.judgedWrong, restored.selfAssessedCorrect, restored.correctCount], [0, 1, 1]);
      },
    },
  },
});
