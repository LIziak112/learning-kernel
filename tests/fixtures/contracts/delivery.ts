import { openLearningRuntime } from "../../../src/server.ts";
import type { PublicationInput, QuestionDeliveryDraftInput, QuestionDeliveryInput, StudentPrincipal, VerdictCommand } from "../../../src/server.ts";

type ReadingPractice = Extract<PublicationInput, { practice: { formatVersion: 1 } }>["practice"];

export type ContractQuestion = Readonly<{
  id: string;
  version: number;
  prompt: string;
  response: string;
  options?: Readonly<Record<string, string>>;
  [field: string]: unknown;
}>;

export type ContractGrading = Readonly<{
  keys: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  teacherReview: readonly string[];
  selfReview?: readonly string[];
}>;

export type DeliveryDeclaration = Readonly<{
  id: string;
  questions: readonly ContractQuestion[];
  grading: ContractGrading;
  mode: "whole" | "perQuestion";
  allowUnanswered: boolean;
  version?: number;
  evaluator?: Readonly<{ id: string; version: number }>;
  policy?: ReadingPractice["policy"];
}>;

export const student = { role: "student", id: "contract-student" } as const;
export const outsider = { role: "student", id: "contract-outsider" } as const;
export const reviewer = { role: "reviewer", id: "contract-reviewer" } as const;
export const slotId = "work";
export const targetId = "contract";
export const evaluatorRef = { id: "contract-evaluator", version: 1 } as const;
export const keyRef = { id: "contract-key", version: 1 } as const;

type Assessment = NonNullable<NonNullable<ReadingPractice["grading"]>["assessment"]>;

const original = { state: "uncollected" } as const;
export const contractPolicy: ReadingPractice["policy"] = {
  offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
  student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt", "ownResponses"], onFinal: [] } },
  reviewer: { scope: "assignedReviewer", fields: ["studentChoices", "gradingBasis"], actions: ["reviseQuestionVerdict"] },
  manager: { scope: "assigningTeacher", actions: [] },
};

export function questionSlot(questionId: string) {
  return `${slotId}-${questionId}`;
}

function deliveryMode(mode: DeliveryDeclaration["mode"], questions: readonly ContractQuestion[]) {
  if (mode === "whole") return { mode };
  return { mode, questionSlots: Object.fromEntries(questions.map(({ id }) => [id, questionSlot(id)])) };
}

function scoringKey({ keys }: ContractGrading, questions: readonly ContractQuestion[], version: number) {
  const acceptedByQuestion = Object.fromEntries(Object.entries(keys).map(([questionId, key]) => {
    const question = questions.find(({ id }) => id === questionId);
    if (!question) throw new Error(`评分键引用了不存在的题：${questionId}`);
    return [questionId, { ...key, response: question.response }];
  }));
  return { ...keyRef, version, acceptedByQuestion };
}

export function deliveryPublication(declaration: DeliveryDeclaration): PublicationInput {
  const { id, questions, grading, mode, allowUnanswered, version = 1, evaluator = evaluatorRef, policy = contractPolicy } = declaration;
  const automatic = Object.keys(grading.keys).length > 0;
  const assessment: Assessment = { from: { stepId: "answer", slotId }, evaluator: { ...evaluator }, keyRef: { ...keyRef, version }, unit: "question",
    effectiveVerdictOrder: ["teacherReview", "automatic"] };
  return {
    practice: {
      id, version, formatVersion: 1, title: "迁移契约", goals: { [targetId]: "完成作答" },
      questions: questions.map(question => ({ ...question })),
      steps: [{
        id: "answer", instructions: "作答。", tool: { id: "question-delivery", version: 1 }, inputs: { questions: { from: "questions" } },
        submit: { purpose: "finalAnswer", slots: { [slotId]: {
          type: "questionDelivery", source: "questions", targetId, delivery: deliveryMode(mode, questions), confirmFromDrafts: { allowUnanswered },
        } } },
        afterConfirmation: "finish",
      }],
      grading: {
        ...automatic ? { assessment } : {},
        ...grading.teacherReview.length > 0 ? { teacherReview: { questionIds: [...grading.teacherReview] } } : {},
        ...grading.selfReview?.length ? { selfReview: { questionIds: [...grading.selfReview] } } : {},
      },
      policy,
    },
    ...automatic ? { scoringKey: scoringKey(grading, questions, version) } : {},
  };
}

type RuntimeOptions = Parameters<typeof openLearningRuntime>[0];
export type Runtime = ReturnType<typeof openLearningRuntime>;
export type Activity = ReturnType<Runtime["start"]>;
export type DeliveryReceipt = ReturnType<Runtime["confirmQuestionDelivery"]>;

export function openRuntime(databasePath: string, options: Omit<RuntimeOptions, "databasePath"> = {}) {
  return openLearningRuntime({ databasePath, verifyOriginal: () => true, authorizeConfirmationRecovery: () => true, ...options });
}

export function startFor(runtime: Runtime, practiceId: string, principal: StudentPrincipal = student, operationId = `start-${practiceId}`) {
  return runtime.start(principal, { protocolVersion: 1, practiceId, practiceVersion: 1, operationId });
}

type DraftOptions = Readonly<{ baseRevision?: number; operationId?: string; principal?: StudentPrincipal }>;
export function saveDraft(
  runtime: Runtime, activity: Activity, question: ContractQuestion, value: QuestionDeliveryDraftInput["value"], options: DraftOptions = {},
) {
  const { baseRevision = 0, operationId = `save-${question.id}-${baseRevision}`, principal = student } = options;
  return runtime.saveQuestionDeliveryDraft(principal, activity.activityId, {
    protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, questionId: question.id, questionVersion: question.version,
    operationId, baseRevision, value,
  });
}

export type Handed = Readonly<{ question: ContractQuestion; revision: number }>;
export function deliveryInput(
  activity: Activity, source: QuestionDeliveryInput["source"], handed: readonly Handed[], operationId: string,
): QuestionDeliveryInput {
  const questions = handed.map(({ question, revision }) => ({ questionId: question.id, questionVersion: question.version, revision, original }));
  const base = { protocolVersion: 1, stepAttemptId: activity.stepAttemptId, slotId, operationId } as const;
  if (source !== "question") return { ...base, source, questions };
  const [only] = questions;
  if (!only || questions.length !== 1) throw new Error("逐题交付一次只交一题");
  return { ...base, source, questions: [only] };
}

export function recoveryKey({ protocolVersion, stepAttemptId, operationId }: QuestionDeliveryInput) {
  return { protocolVersion, stepAttemptId, operationId };
}

type Verdict = Readonly<{ receipt: DeliveryReceipt; questionId: string; operationId: string; expectedRevision: number }>;
export function override({ receipt, questionId, operationId, expectedRevision }: Verdict, correct: boolean): VerdictCommand {
  return { protocolVersion: 1, action: "override", submissionId: receipt.id, targetId, questionId, operationId, expectedRevision,
    reason: "契约复核：教师改判", correct };
}

export function withdraw({ receipt, questionId, operationId, expectedRevision }: Verdict, withdrawId: string): VerdictCommand {
  return { protocolVersion: 1, action: "withdraw", submissionId: receipt.id, targetId, questionId, operationId, expectedRevision,
    reason: "契约复核：清除改判", withdrawId };
}
