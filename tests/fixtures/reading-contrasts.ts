import { strict as assert } from "node:assert";
import library from "../../practices/reading-library.json" with { type: "json" };

const { material, practice, scoringKey } = library;
const { questions, steps, grading, policy, ...base } = practice;
const [selection, answers] = steps;
const [question] = questions;
assert.ok(selection && answers && question);
const selectionSlot = selection.submit.slots.quotes;
const answerSlot = answers.submit.slots.choices;
assert.ok(selectionSlot && answerSlot);

const { timeLimit, student, ...withoutLimit } = policy;
const { passageScore, review, ...ownRecord } = student;

export const contrastA = {
  material,
  practice: {
    ...base, id: "evidence-and-explanation", title: "两题阅读", questions: questions.slice(0, 2),
    steps: [
      { ...selection, id: "gather", submit: { ...selection.submit, slots: { excerpts: selectionSlot } } },
      {
        ...answers, id: "interpret-pass", requires: "gather",
        inputs: {
          passage: answers.inputs.passage, items: answers.inputs.items,
          quoteSource: { from: "submission", stepId: "gather", slotId: "excerpts", readOnly: true },
        },
        submit: { ...answers.submit, slots: { response: answerSlot, support: { type: "reuse", source: "quoteSource" } } },
      },
    ],
    grading: {
      selectionFeedback: { ...grading.selectionFeedback, from: { stepId: "gather", slotId: "excerpts" } },
      assessment: { ...grading.assessment, from: { stepId: "interpret-pass", slotId: "response" }, keyRef: { id: "two-item-key", version: 1 } },
    },
    policy: { ...withoutLimit, timeLimit, student: { ...ownRecord, passageScore, review } },
  },
  scoringKey: {
    ...scoringKey, id: "two-item-key",
    acceptedChoices: Object.fromEntries(questions.slice(0, 2).map(({ id }) => [id, scoringKey.acceptedChoices[id as keyof typeof scoringKey.acceptedChoices]])),
  },
};

const noAssessment = {
  ...withoutLimit,
  student: { ...ownRecord, ownSubmission: { ...ownRecord.ownSubmission, onFinal: [] } },
  reviewer: { ...policy.reviewer, fields: ["submittedQuotes", "studentChoices"], actions: [] },
  manager: { ...policy.manager, actions: [] },
};

export const contrastB = {
  material,
  practice: {
    ...base, id: "evidence-only", title: "只选引文", goals: { cite: base.goals.cite },
    steps: [{ ...selection, afterConfirmation: "finish" }],
    policy: { ...noAssessment, timeLimit },
  },
};

const choices = {
  tool: answers.tool,
  inputs: { questions: { from: "questions" } },
};
const newChoiceSlot = { ...answerSlot, source: "questions" };

export const contrastC = {
  material,
  practice: {
    ...base, id: "two-kept-answers", title: "两次作答", goals: { interpret: base.goals.interpret },
    questions: [{ ...question, prompt: "延时开放的前两周每晚约有三十人到馆。哪项说法可以得到支持？" }], policy: noAssessment,
    steps: [
      {
        ...choices, id: "first-answer", instructions: "交出第一次判断。",
        submit: { purpose: "stepEvidence", slots: { original: newChoiceSlot } }, afterConfirmation: "advance",
      },
      {
        ...choices, id: "second-answer", requires: "first-answer", instructions: "核对原答，再提交第二次判断。",
        inputs: { ...choices.inputs, original: { from: "submission", stepId: "first-answer", slotId: "original", readOnly: true } },
        submit: { purpose: "finalAnswer", slots: { revised: newChoiceSlot, previous: { type: "reuse", source: "original" } } },
        afterConfirmation: "finish",
      },
    ],
  },
};
