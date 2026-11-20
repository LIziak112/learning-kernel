import type { QuestionDeliveryFormat, QuestionDeliveryKey } from "../contracts/question-delivery.ts";
import type { VersionRef } from "../contracts/reading.ts";
import type { ReadingPublication, ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";
import { findResponseEvaluator } from "../contracts/response-evaluation.ts";
import type { PublicationEvaluators } from "./publication-bindings.ts";

type Issue = (path: (string | number)[], message: string) => void;
type Question = ReadingPublication["practice"]["questions"][number];
export type DeliverySlot = Extract<ReadingSlot, { type: "questionDelivery" }>;

export function questionDeliverySlot(step: ReadingStep) {
  return Object.entries(step.submit.slots).find((entry): entry is [string, DeliverySlot] => entry[1].type === "questionDelivery");
}

export function validateQuestionDeliveryPublication(publication: ReadingPublication, registered: PublicationEvaluators, issue: Issue) {
  const { practice, scoringKey } = publication;
  const delivery = locateDelivery(practice.steps);
  if (!delivery) {
    rejectUnboundQuestionFormats(practice.questions, issue);
    return false;
  }
  const { step, slotId } = delivery;
  const ids = new Set(practice.questions.map(question => question.id));
  validateDeliveryLocations(delivery, practice.steps.length, ids, issue);
  const formats = validateQuestionFormats(practice.questions, issue);
  const assessment = practice.grading.assessment;
  validateDeliveryAssessment(assessment, { stepId: step.id, slotId }, formats, registered, issue);
  if (validateDeliveryKey(scoringKey, assessment?.keyRef, issue)) {
    validateQuestionKeys(practice.questions, scoringKey.acceptedByQuestion, ids, issue);
  }
  return true;
}

function locateDelivery(steps: readonly ReadingStep[]) {
  for (const step of steps) {
    const binding = questionDeliverySlot(step);
    if (binding) return { step, slotId: binding[0], slot: binding[1] };
  }
  return undefined;
}

function validateDeliveryLocations(
  { step, slot, slotId }: NonNullable<ReturnType<typeof locateDelivery>>, stepCount: number, ids: ReadonlySet<string>, issue: Issue,
) {
  if (stepCount !== 1 || step.submit.purpose !== "finalAnswer" || ids.size === 0) {
    issue(["practice", "steps"], "逐题交付须绑定一组非空冻结题的单步作答");
  }
  if (slot.delivery.mode === "perQuestion") validateQuestionSlots(slot.delivery.questionSlots, slotId, ids, issue);
}

function rejectUnboundQuestionFormats(questions: readonly Question[], issue: Issue) {
  for (const [index, question] of questions.entries()) {
    if (question.response) issue(["practice", "questions", index, "response"], "逐题形态须绑定逐题交付槽");
  }
}

type DeliveryKey = Extract<ReadingPublication["scoringKey"], { acceptedByQuestion: unknown }>;

function validateDeliveryKey(key: ReadingPublication["scoringKey"], reference: VersionRef | undefined, issue: Issue): key is DeliveryKey {
  if (!key || !("acceptedByQuestion" in key)) {
    issue(["scoringKey"], "逐题交付须提供按题冻结的评分键");
    return false;
  }
  if (reference && (key.id !== reference.id || key.version !== reference.version)) {
    issue(["practice", "grading", "assessment", "keyRef"], "评估引用须指向本次冻结的评分键");
  }
  return true;
}

function validateQuestionFormats(questions: readonly Question[], issue: Issue) {
  const formats = new Set<QuestionDeliveryFormat>();
  for (const [index, { version, response, options }] of questions.entries()) {
    if (version === undefined) issue(["practice", "questions", index, "version"], "逐题交付须固定题版");
    if (!response) {
      issue(["practice", "questions", index, "response"], "逐题交付须声明题的原值形态");
      continue;
    }
    if (response === "optionIndexArray" && Object.keys(options).some((id, index) => id !== String(index))) {
      issue(["practice", "questions", index, "options"], "索引题须冻结从零连续编号的选项");
    }
    formats.add(response);
  }
  return formats;
}

function validateQuestionSlots(slots: Readonly<Record<string, string>>, logicalSlot: string, ids: ReadonlySet<string>, issue: Issue) {
  const path = ["practice", "steps", 0, "submit", "slots", logicalSlot, "delivery", "questionSlots"] as const;
  const occupied = new Set([logicalSlot]);
  for (const [questionId, physicalSlot] of Object.entries(slots)) {
    if (!ids.has(questionId)) issue([...path, questionId], "位置须绑定已发布的题");
    if (occupied.has(physicalSlot)) issue([...path, questionId], "交付位置须唯一");
    occupied.add(physicalSlot);
  }
  for (const questionId of ids) {
    if (!Object.hasOwn(slots, questionId)) issue([...path, questionId], "题缺少交付位置");
  }
}

type Assessment = NonNullable<ReadingPublication["practice"]["grading"]["assessment"]>;

function validateDeliveryAssessment(
  assessment: Assessment | undefined, output: Assessment["from"], formats: ReadonlySet<QuestionDeliveryFormat>, registered: PublicationEvaluators, issue: Issue,
) {
  if (!assessment) return;
  if (assessment.from.stepId !== output.stepId || assessment.from.slotId !== output.slotId) {
    issue(["practice", "grading", "assessment", "from"], "须绑定本组逐题交付的逻辑槽");
  }
  const evaluators = {
    choice: registered.choice, booleanOrString: registered.scalar, optionIndexArray: registered.indexes,
    orderedTextBlanks: registered.orderedText, textWithOptionalTitle: registered.titledText,
  };
  for (const format of formats) {
    const available: readonly (VersionRef & { evaluate: unknown })[] = evaluators[format] ?? [];
    if (!findResponseEvaluator(available, assessment.evaluator)) {
      issue(["practice", "grading", "assessment", "evaluator"], `未注册 ${format} 所需的精确评估版本`);
    }
  }
}

function validateQuestionKeys(questions: readonly Question[], keys: Readonly<Record<string, QuestionDeliveryKey>>, ids: ReadonlySet<string>, issue: Issue) {
  const pathFor = (id: string) => ["scoringKey", "acceptedByQuestion", id];
  for (const question of questions) {
    const key = Object.hasOwn(keys, question.id) ? keys[question.id] : undefined;
    if (!key || !keyMatchesQuestion(key, question)) {
      issue(pathFor(question.id), "私有键须匹配本题的冻结形态、选项或空位");
    }
  }
  for (const id of Object.keys(keys)) {
    if (!ids.has(id)) issue(pathFor(id), "私有键引用了不存在的题");
  }
}

function keyMatchesQuestion(key: QuestionDeliveryKey, question: Question) {
  if (key.response !== question.response) return false;
  const { options } = question;
  switch (key.response) {
    case "choice": return Object.hasOwn(options, key.acceptedChoice);
    case "booleanOrString":
    case "textWithOptionalTitle": return true;
    case "optionIndexArray": return key.acceptedIndexes.every(index => Object.hasOwn(options, String(index)));
    case "orderedTextBlanks": return question.response === "orderedTextBlanks" && key.acceptedBlanks.length === question.blankCount;
  }
}
