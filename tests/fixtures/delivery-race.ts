import type { PublicationInput, QuestionDeliveryInput } from "../../src/server.ts";

export const raceQuestions = [
  { id: "first", version: 1, prompt: "第一题。", response: "booleanOrString", options: { yes: "是", no: "否" } },
  { id: "second", version: 1, prompt: "第二题。", response: "booleanOrString", options: { yes: "是", no: "否" } },
];
export const questionSlots = { first: "first-slot", second: "second-slot" };

export const racePublication = {
  practice: {
    id: "delivery-race", version: 1, formatVersion: 1, title: "逐题与收卷竞争", goals: { answer: "作答" }, questions: raceQuestions,
    steps: [{
      id: "answer", instructions: "逐题作答。", tool: { id: "question-delivery", version: 1 }, inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { answers: {
        type: "questionDelivery", source: "questions", targetId: "answer", delivery: { mode: "perQuestion", questionSlots },
        confirmFromDrafts: { allowUnanswered: true },
      } } },
      afterConfirmation: "finish",
    }],
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
    },
  },
} satisfies PublicationInput;

export function raceInput(mode: "question" | "finish", stepAttemptId: string): QuestionDeliveryInput {
  const revision = (id: string) => ({ questionId: id, questionVersion: 1, revision: 1, original: { state: "uncollected" as const } });
  if (mode === "question") {
    return { protocolVersion: 1, stepAttemptId, slotId: "answers", source: "question", operationId: "first-only", questions: [revision("first")] };
  }
  return { protocolVersion: 1, stepAttemptId, slotId: "answers", source: "finish", operationId: "finish-early",
    questions: raceQuestions.map(({ id }) => revision(id)) };
}
