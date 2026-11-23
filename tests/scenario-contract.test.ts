import type { PublicationInput } from "../src/server.ts";
import { scenarioContract, stubEvaluatorRef, stubKeyRef, stubQuestions, stubScoringKey, student } from "./fixtures/contracts/scenario-contract.ts";
import type { Harness, ScenarioModule } from "./fixtures/contracts/scenario-contract.ts";

type ReadingPractice = Extract<PublicationInput, { practice: { formatVersion: 1 } }>["practice"];
const slotId = "answers";

function perQuestionPublication(practiceId: string) {
  const practice = {
    id: practiceId, version: 1, formatVersion: 1, title: "逐题交付", goals: { answer: "逐题作答" },
    questions: stubQuestions.map(question => ({ ...question })),
    steps: [{
      id: "answer", instructions: "逐题提交。", tool: { id: "question-delivery", version: 1 }, inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { [slotId]: {
        type: "questionDelivery", source: "questions", targetId: "answer", confirmFromDrafts: { allowUnanswered: true },
        delivery: { mode: "perQuestion", questionSlots: Object.fromEntries(stubQuestions.map(({ id }) => [id, `position-${id}`])) },
      } } },
      afterConfirmation: "finish",
    }],
    grading: { assessment: { from: { stepId: "answer", slotId }, evaluator: stubEvaluatorRef, keyRef: stubKeyRef, unit: "question",
      effectiveVerdictOrder: ["teacherReview", "automatic"] } },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  } satisfies ReadingPractice;
  return { practice, scoringKey: stubScoringKey } satisfies PublicationInput;
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

const modules: readonly ScenarioModule[] = [
  { group: "G35", title: "逐题交付：逐题提交与分段结算", publication: perQuestionPublication, handIn: handInOneQuestion },
];

for (const module of modules) scenarioContract(module);
