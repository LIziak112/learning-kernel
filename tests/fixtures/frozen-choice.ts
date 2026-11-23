import frozen from "./frozen-choice.json" with { type: "json" };
import type { PublicationInput } from "../../src/server.ts";

export const practiceId = "two-frozen-questions";
export const questions = frozen.questions.map(({ id, stemMd, options }) => ({
  id, prompt: stemMd, options: Object.fromEntries(options.map((option, index) => [String(index), option])),
}));
export const frozenChoicePublication = {
  practice: {
    id: practiceId, version: 1, formatVersion: 1, title: "两道合成单选",
    goals: { answer: "选择每题的一个选项。" }, questions,
    steps: [{
      id: "answer", instructions: "选择每题的一个选项。", tool: { id: "single-choice-group", version: 1 },
      inputs: { questions: { from: "questions" } },
      submit: { purpose: "finalAnswer", slots: { answers: { type: "oneChoicePerQuestion", source: "questions", targetId: "answer" } } },
      afterConfirmation: "finish",
    }],
    grading: {
      assessment: {
        from: { stepId: "answer", slotId: "answers" }, evaluator: { id: "choice-key", version: 1 },
        keyRef: { id: `${practiceId}-key`, version: 1 }, unit: "question", effectiveVerdictOrder: ["teacherReview", "automatic"],
      },
    },
    policy: {
      offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
      student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownChoices"], onFinal: [] } },
      reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] },
      manager: { scope: "assigningTeacher", actions: [] },
    },
  },
  scoringKey: {
    id: `${practiceId}-key`, version: 1,
    acceptedChoices: Object.fromEntries(frozen.questions.map(({ id, answers }) => [id, String(answers.index)])),
  },
} satisfies PublicationInput;


export const questionVersions = new Map(frozen.questions.map(question => [question.id, question.version]));
