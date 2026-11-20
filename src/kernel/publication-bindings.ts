import { choiceKeyCapability, readingCapability, studentTool } from "../builtins/reading-capabilities.ts";
import type { ValueType } from "../builtins/reading-capabilities.ts";
import { findChoiceEvaluator } from "../contracts/choice-evaluation.ts";
import type { ChoiceEvaluatorRegistration } from "../contracts/choice-evaluation.ts";
import type { BoundQuestionAnswerRules } from "../contracts/question-answer-rule.ts";
import { findResponseEvaluator } from "../contracts/response-evaluation.ts";
import type { IndexResponseEvaluatorRegistration, OrderedTextEvaluatorRegistration, ResponseEvaluatorRegistration, TitledTextEvaluatorRegistration } from "../contracts/response-evaluation.ts";
import type { ResponseFormat } from "../contracts/response.ts";
import type { VersionRef } from "../contracts/reading.ts";
import type { ReadingPublication, ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";
import { validateMaterialPositions } from "./material-positions.ts";
import { validateQuestionDeliveryPublication } from "./question-delivery-publication.ts";

type Issue = (path: (string | number)[], message: string) => void;
export type PublicationEvaluators = {
  choice?: readonly ChoiceEvaluatorRegistration[];
  scalar?: readonly ResponseEvaluatorRegistration[];
  indexes?: readonly IndexResponseEvaluatorRegistration[];
  orderedText?: readonly OrderedTextEvaluatorRegistration[];
  titledText?: readonly TitledTextEvaluatorRegistration[];
};

export function validateBindings(
  publication: ReadingPublication, issue: Issue, registered: PublicationEvaluators, answerRules: BoundQuestionAnswerRules,
) {
  const { practice } = publication;
  const earlierSteps = new Map<string, ReadingStep>();
  const positions = new Set<string>();
  for (const [index, step] of practice.steps.entries()) {
    const report: Issue = (path, message) => issue(["practice", "steps", index, ...path], message);
    if (earlierSteps.has(step.id)) report(["id"], "步骤标识重复");
    if (step.requires !== practice.steps[index - 1]?.id) report(["requires"], "须引用紧邻的前序步骤");
    const transition = index === practice.steps.length - 1 ? "finish" : "advance";
    if (step.afterConfirmation !== transition) report(["afterConfirmation"], "确认后的动作与步骤顺序不一致");
    const inputs = resolveInputs(step, earlierSteps, positions, report);
    validateTool(step, inputs, report);
    validateSlots(step, inputs, practice.goals, report);
    validateDraftConfirmation(step, practice, report);
    earlierSteps.set(step.id, step);
  }
  validateMaterialPositions(publication, issue);
  validateGrading(practice.grading, earlierSteps, registered, issue);
  validateAssessmentPublication(publication, registered, answerRules, issue);
  validateQuestions(practice, issue);
}

function validateAssessmentPublication(
  publication: ReadingPublication, registered: PublicationEvaluators, answerRules: BoundQuestionAnswerRules, issue: Issue,
) {
  const { practice, scoringKey } = publication;
  const response = practice.steps.flatMap(step => Object.values(step.submit.slots))
    .find(slot => slot.type === "oneResponsePerQuestion")?.input;
  const questionDelivery = validateQuestionDeliveryPublication(publication, registered, answerRules, issue);
  validateResponsePolicy(practice, questionDelivery || response !== undefined, issue);
  if (!questionDelivery) validateAssessmentPolicy(practice, scoringKey, response, issue);
}

function validateDraftConfirmation(step: ReadingStep, practice: ReadingPublication["practice"], issue: Issue) {
  const requested = Object.values(step.submit.slots).find(hasDraftConfirmation);
  if (!requested) return;
  if (!isSingleFinalStep(practice, step) || ("reasonTargetId" in requested && requested.reasonTargetId)) {
    issue(["submit", "slots"], requested.type === "oneChoicePerQuestion"
      ? "草稿确认要求一个单步整卷单选槽" : "草稿确认要求一个单步整卷原值槽");
  }
  if (practice.questions.some(question => question.version === undefined)) {
    issue(["submit", "slots"], "草稿确认须固定每道题的版本");
  }
}

function hasDraftConfirmation(slot: ReadingSlot): slot is Extract<ReadingSlot, { type: "oneChoicePerQuestion" | "oneResponsePerQuestion" }> {
  return (slot.type === "oneChoicePerQuestion" || slot.type === "oneResponsePerQuestion") && slot.confirmFromDrafts !== undefined;
}

function isSingleFinalStep(practice: ReadingPublication["practice"], step: ReadingStep) {
  return practice.steps.length === 1 && step.submit.purpose === "finalAnswer";
}

function validateQuestions(practice: ReadingPublication["practice"], issue: Issue) {
  const ids = new Set<string>();
  for (const [index, question] of practice.questions.entries()) {
    if (ids.has(question.id)) issue(["practice", "questions", index, "id"], "题指标识重复");
    ids.add(question.id);
  }
  if (practice.questions.length === 0 && practice.steps.some(step => Object.values(step.inputs).some(input => input.from === "questions"))) {
    issue(["practice", "questions"], "绑定题目输入时须声明至少一题");
  }
}

function resolveInputs(
  step: ReadingStep,
  earlierSteps: ReadonlyMap<string, ReadingStep>,
  positions: Set<string>,
  issue: Issue,
) {
  const inputs = new Map<string, ValueType>();
  for (const [name, input] of Object.entries(step.inputs)) {
    if (input.from === "material") {
      if (positions.has(input.positionId)) issue(["inputs", name, "positionId"], "材料使用位置重复");
      positions.add(input.positionId);
    }
    if (input.from === "submission") {
      if (!earlierSteps.has(input.stepId)) {
        issue(["inputs", name, "stepId"], "须引用前序步骤");
        continue;
      }
      const slot = findSlot(earlierSteps, input);
      if (!slot || slot.type === "reuse") {
        issue(["inputs", name, "slotId"], "须引用前序步骤已有的原始交付槽位");
        continue;
      }
      inputs.set(name, slot.type);
    } else {
      inputs.set(name, input.from);
    }
  }
  return inputs;
}

function validateTool(step: ReadingStep, inputs: ReadonlyMap<string, ValueType>, issue: Issue) {
  const capability = studentTool(step.tool);
  if (!capability) {
    issue(["tool"], "须绑定已登记且允许学生调用的工具版本");
    return;
  }
  const types = new Set(inputs.values());
  if (capability.requiredInputs.some(type => !types.has(type))) {
    issue(["inputs"], "缺少工具要求的输入类型");
  }
  const acceptedInputs = new Set<ValueType>([...capability.requiredInputs, ...capability.optionalInputs]);
  for (const [name, type] of inputs) {
    if (!acceptedInputs.has(type)) {
      issue(["inputs", name], "工具不接受此输入类型");
    }
  }
  validateOutputs(step.submit.slots, capability.outputs, issue);
}

function validateOutputs(slots: Readonly<Record<string, ReadingSlot>>, outputs: readonly ValueType[], issue: Issue) {
  const entries = Object.entries(slots);
  for (const [name, slot] of entries) {
    if (slot.type !== "reuse" && !outputs.includes(slot.type)) {
      issue(["submit", "slots", name, "type"], "槽位类型与工具输出不一致");
    }
  }
  if (entries.filter(([, slot]) => slot.type !== "reuse").length !== 1) {
    issue(["submit", "slots"], "步骤须恰有一个新交付槽位");
  }
}

function validateSlots(
  step: ReadingStep,
  inputs: ReadonlyMap<string, ValueType>,
  goals: Readonly<Record<string, string>>,
  issue: Issue,
) {
  for (const [name, slot] of Object.entries(step.submit.slots)) {
    const path = ["submit", "slots", name];
    if (!sourceMatchesSlot(slot, inputs.get(slot.source))) {
      issue([...path, "source"], "槽位须引用本步骤中类型匹配的输入");
    }
    if (slot.type !== "reuse" && !Object.hasOwn(goals, slot.targetId)) {
      issue([...path, "targetId"], "槽位引用的目标不存在");
    }
    if (slot.type === "oneChoicePerQuestion" && slot.reasonTargetId && !Object.hasOwn(goals, slot.reasonTargetId)) {
      issue([...path, "reasonTargetId"], "理由引用的目标不存在");
    }
  }
}

function sourceMatchesSlot(slot: ReadingSlot, input: ValueType | undefined) {
  switch (slot.type) {
    case "passageSelection": return input === "material";
    case "oneChoicePerQuestion":
    case "oneResponsePerQuestion":
    case "questionDelivery": return input === "questions";
    case "reuse": return input === "passageSelection" || input === "oneChoicePerQuestion";
  }
}

function validateGrading(
  grading: ReadingPublication["practice"]["grading"],
  steps: ReadonlyMap<string, ReadingStep>,
  registered: PublicationEvaluators,
  issue: Issue,
) {
  const { selectionFeedback, assessment } = grading;
  if (selectionFeedback && findSlot(steps, selectionFeedback.from)?.type !== "passageSelection") {
    issue(["practice", "grading", "selectionFeedback", "from"], "评语须绑定选区交付槽位");
  }
  if (assessment) validateAssessmentBinding(findSlot(steps, assessment.from), assessment.evaluator, registered, issue);
}

function validateAssessmentBinding(
  slot: ReadingSlot | undefined, evaluator: VersionRef, { choice = [], scalar = [], indexes = [] }: PublicationEvaluators, issue: Issue,
) {
  if (slot?.type === "questionDelivery") return;
  if (slot?.type === "oneResponsePerQuestion") {
    const evaluate = slot.input === "optionIndexArray" ? findResponseEvaluator(indexes, evaluator) : findResponseEvaluator(scalar, evaluator);
    if (!evaluate) {
      issue(["practice", "grading", "assessment", "evaluator"], "原值确认须绑定精确版本的原值评估器");
    }
  } else if (slot?.type === "oneChoicePerQuestion") {
    validateAssessmentEvaluator(slot, evaluator, choice, issue);
  } else {
    issue(["practice", "grading", "assessment", "from"], "逐题评估须绑定单选交付槽位");
  }
}

function validateAssessmentEvaluator(
  slot: Extract<ReadingSlot, { type: "oneChoicePerQuestion" }>,
  evaluator: VersionRef,
  registered: readonly ChoiceEvaluatorRegistration[],
  issue: Issue,
) {
  const path = ["practice", "grading", "assessment", "evaluator"];
  if (slot.confirmFromDrafts) {
    if (!findChoiceEvaluator(registered, evaluator)) {
      issue(path, "草稿确认槽须注册精确版本的宿主评估器，内置评分用于旧声明");
    }
    return;
  }
  if (readingCapability(evaluator) !== choiceKeyCapability) {
    issue(path, "须绑定获准读取评分键并输出逐题判定的服务端评估器");
  }
}

function validateResponsePolicy(practice: ReadingPublication["practice"], response: boolean, issue: Issue) {
  const { student, reviewer, manager } = practice.policy;
  const { fields } = student.ownSubmission;
  if (!response) {
    if (fields.includes("ownResponses")) issue(["practice", "policy", "student", "ownSubmission", "fields"], "原值回看须使用原值提交槽");
    return;
  }
  if (!practice.grading.assessment) issue(["practice", "grading", "assessment"], "原值确认须声明固定评估");
  validateResponseStudentPolicy(student, issue);
  if (reviewer.fields.length || reviewer.actions.length || manager.actions.length) {
    issue(["practice", "policy"], "原值确认不声明阅读评阅动作或字段");
  }
}

function validateResponseStudentPolicy(student: ReadingPublication["practice"]["policy"]["student"], issue: Issue) {
  const { fields, onFinal } = student.ownSubmission;
  if (onFinal.length || student.passageScore || student.review || fields.some(field => field !== "receipt" && field !== "ownResponses")) {
    issue(["practice", "policy"], "原值确认只支持回执与本人获准作答");
  }
}

function validateAssessmentPolicy(
  practice: ReadingPublication["practice"], key: ReadingPublication["scoringKey"], response: ResponseFormat | undefined, issue: Issue,
) {
  const { assessment } = practice.grading;
  const { passageScore, review, ownSubmission } = practice.policy.student;
  if (review && !passageScore) issue(["practice", "policy", "student", "review"], "开放复盘须声明整篇公布条件");
  if (Boolean(assessment) !== Boolean(key)) issue(["scoringKey"], "评分声明与固定评分键须成对提供");
  if (!assessment && (passageScore || ownSubmission.onFinal.length)) {
    issue(["practice", "policy", "student", "passageScore"], "公布成绩须声明评估槽位和规则");
  }
  if (assessment && key) validateKey(practice, assessment.keyRef, key, response, issue);
}

function findSlot(steps: ReadonlyMap<string, ReadingStep>, reference: { stepId: string; slotId: string }) {
  const slots = steps.get(reference.stepId)?.submit.slots;
  return slots && Object.hasOwn(slots, reference.slotId) ? slots[reference.slotId] : undefined;
}

function validateKey(
  practice: ReadingPublication["practice"],
  reference: { id: string; version: number },
  key: NonNullable<ReadingPublication["scoringKey"]>,
  response: ResponseFormat | undefined,
  issue: Issue,
) {
  if (reference.id !== key.id || reference.version !== key.version) {
    issue(["practice", "grading", "assessment", "keyRef"], "评估引用的评分键版本与发布评分键不一致");
  }
  const field = response === "optionIndexArray" ? "acceptedIndexes" : response === "booleanOrString" ? "acceptedResponses" : "acceptedChoices";
  if (!(field in key)) {
    issue(["scoringKey"], "评分键须与提交槽位类型一致");
    return;
  }
  if ("acceptedIndexes" in key) {
    validateIndexKey(practice.questions, key.acceptedIndexes, issue);
  } else if ("acceptedResponses" in key) {
    validateQuestionKeys(practice.questions, "acceptedResponses", key.acceptedResponses, "每道题须具有对应的布尔评分键", () => true, issue);
  } else if ("acceptedChoices" in key) {
    validateQuestionKeys(practice.questions, "acceptedChoices", key.acceptedChoices, "评分键须指向本题存在的选项",
      (question, choice) => Object.hasOwn(question.options, choice), issue);
  }
}

type PublishedQuestion = ReadingPublication["practice"]["questions"][number];

function validateIndexKey(questions: readonly PublishedQuestion[], values: Readonly<Record<string, readonly number[]>>, issue: Issue) {
  for (const [index, question] of questions.entries()) {
    if (Object.keys(question.options).some((id, position) => id !== String(position))) {
      issue(["practice", "questions", index, "options"], "索引题须冻结从零连续编号的选项");
    }
  }
  validateQuestionKeys(questions, "acceptedIndexes", values, "索引评分键须指向本题存在的选项",
    (question, indexes) => indexes.every(index => Object.hasOwn(question.options, String(index))), issue);
}

function validateQuestionKeys<T>(
  questions: readonly PublishedQuestion[], field: string, values: Readonly<Record<string, T>>, missing: string,
  accepts: (question: PublishedQuestion, value: T) => boolean, issue: Issue,
) {
  const ids = new Set(questions.map(question => question.id));
  for (const question of questions) {
    const answer = values[question.id];
    if (!Object.hasOwn(values, question.id) || answer === undefined || !accepts(question, answer)) {
      issue(["scoringKey", field, question.id], missing);
    }
  }
  for (const question of Object.keys(values)) {
    if (!ids.has(question)) issue(["scoringKey", field, question], "评分键引用的题目不存在");
  }
}
