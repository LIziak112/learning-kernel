import type { StudentValue } from "../contracts/capabilities.ts";
import type { VersionRef } from "../contracts/reading.ts";
import { questionFields } from "../contracts/reading-publication.ts";
import type { ReadingPublication, ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";
import { validateMaterialPositions } from "./material-positions.ts";
import { validateQuestionDeliveryPublication } from "./question-delivery-publication.ts";
import { questionResponseType, slotResponseType, wholePaperQuestionKey, wholePaperValues } from "./question-types.ts";
import type { Registry } from "./registry.ts";

type Issue = (path: (string | number)[], message: string) => void;

export function validateBindings(publication: ReadingPublication, issue: Issue, registry: Registry) {
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
    validateTool(step, inputs, registry, report);
    validateSlots(step, inputs, practice.goals, report);
    validateDraftConfirmation(step, practice, report);
    earlierSteps.set(step.id, step);
  }
  validateMaterialPositions(publication, registry, issue);
  validateGrading(practice.grading, earlierSteps, registry, issue);
  validateQuestions(practice, registry, issue);
  validateAssessmentPublication(publication, registry, issue);
}

function validateAssessmentPublication(publication: ReadingPublication, registry: Registry, issue: Issue) {
  const { practice, scoringKey } = publication;
  const response = practice.steps.flatMap(step => Object.values(step.submit.slots))
    .find(slot => slot.type === "oneResponsePerQuestion")?.input;
  const questionDelivery = validateQuestionDeliveryPublication(publication, registry, issue);
  if (questionDelivery) {
    validateResponsePolicy(practice, "questionDelivery", issue);
    return;
  }
  if (practice.grading.manualReview) issue(["practice", "grading", "manualReview"], "人工评阅须绑定题组交付槽");
  if (response !== undefined && !practice.grading.assessment) issue(["practice", "grading", "assessment"], "原值确认须声明固定评估");
  validateResponsePolicy(practice, response === undefined ? "none" : "response", issue);
  validateAssessmentPolicy(practice, scoringKey, registry, issue);
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

function validateQuestions(practice: ReadingPublication["practice"], registry: Registry, issue: Issue) {
  const ids = new Set<string>();
  for (const [index, question] of practice.questions.entries()) {
    const report: Issue = (path, message) => issue(["practice", "questions", index, ...path], message);
    if (ids.has(question.id)) report(["id"], "题指标识重复");
    ids.add(question.id);
    validateQuestionShape(question, questionResponseType(registry, practice, question), registry, report);
  }
  if (practice.questions.length === 0 && practice.steps.some(step => Object.values(step.inputs).some(input => input.from === "questions"))) {
    issue(["practice", "questions"], "绑定题目输入时须声明至少一题");
  }
}

function validateQuestionShape(
  question: ReadingPublication["practice"]["questions"][number], typeId: string | undefined, registry: Registry, issue: Issue,
) {
  const type = typeId === undefined ? undefined : registry.responseType(typeId);
  if (!type) {
    issue(["response"], "须声明已登记的作答形态");
    return;
  }
  const declared = new Set<string>([...questionFields, ...type.config]);
  for (const field of Object.keys(question)) {
    if (!declared.has(field)) issue([field], "题目字段不属于声明的作答形态");
  }
  type.validateQuestion(question, (path, message) => issue([...path], message));
}

function resolveInputs(
  step: ReadingStep,
  earlierSteps: ReadonlyMap<string, ReadingStep>,
  positions: Set<string>,
  issue: Issue,
) {
  const inputs = new Map<string, StudentValue>();
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

function validateTool(step: ReadingStep, inputs: ReadonlyMap<string, StudentValue>, registry: Registry, issue: Issue) {
  const capability = registry.tool(step.tool);
  if (!capability) {
    issue(["tool"], "须绑定已登记且允许学生调用的工具版本");
    return;
  }
  const types = new Set(inputs.values());
  if (capability.requiredInputs.some(type => !types.has(type))) {
    issue(["inputs"], "缺少工具要求的输入类型");
  }
  const acceptedInputs = new Set<StudentValue>([...capability.requiredInputs, ...capability.optionalInputs]);
  for (const [name, type] of inputs) {
    if (!acceptedInputs.has(type)) {
      issue(["inputs", name], "工具不接受此输入类型");
    }
  }
  validateOutputs(step.submit.slots, capability.outputs, issue);
}

function validateOutputs(slots: Readonly<Record<string, ReadingSlot>>, outputs: readonly StudentValue[], issue: Issue) {
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
  inputs: ReadonlyMap<string, StudentValue>,
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

function sourceMatchesSlot(slot: ReadingSlot, input: StudentValue | undefined) {
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
  registry: Registry,
  issue: Issue,
) {
  const { selectionFeedback, assessment } = grading;
  if (selectionFeedback && findSlot(steps, selectionFeedback.from)?.type !== "passageSelection") {
    issue(["practice", "grading", "selectionFeedback", "from"], "评语须绑定选区交付槽位");
  }
  if (assessment) validateAssessmentBinding(steps.get(assessment.from.stepId), findSlot(steps, assessment.from), assessment.evaluator, registry, issue);
}

function validateAssessmentBinding(
  step: ReadingStep | undefined, slot: ReadingSlot | undefined, evaluator: VersionRef, registry: Registry, issue: Issue,
) {
  if (slot?.type === "questionDelivery") return;
  const responseType = step && slot && slotResponseType(registry, step, slot);
  if (responseType === undefined) {
    issue(["practice", "grading", "assessment", "from"], "逐题评估须绑定逐题作答的交付槽位");
  } else if (!registry.evaluator(evaluator)?.responseTypes.includes(responseType)) {
    issue(["practice", "grading", "assessment", "evaluator"], "须绑定已登记且覆盖本槽作答形态的精确评估器版本");
  }
}

function validateResponsePolicy(practice: ReadingPublication["practice"], delivery: "none" | "response" | "questionDelivery", issue: Issue) {
  const { student, reviewer, manager } = practice.policy;
  const { fields } = student.ownSubmission;
  if (delivery === "none") {
    if (fields.includes("ownResponses")) issue(["practice", "policy", "student", "ownSubmission", "fields"], "原值回看须使用原值提交槽");
    return;
  }
  validateResponseStudentPolicy(student, delivery === "questionDelivery", issue);
  if (reviewer.fields.some(field => !responseReviewerFields.has(field)) || reviewer.actions.some(action => action !== "reviseQuestionVerdict")
    || manager.actions.length) {
    issue(["practice", "policy"], "原值确认的评阅只声明学生原答、判定历史、评阅依据与逐题改判");
  }
}

const responseReviewerFields = new Set<string>(["studentChoices", "verdictHistory", "gradingBasis"]);

function validateResponseStudentPolicy(student: ReadingPublication["practice"]["policy"]["student"], publishesScore: boolean, issue: Issue) {
  const { fields, onFinal } = student.ownSubmission;
  const score = !publishesScore && (onFinal.length > 0 || student.passageScore !== undefined);
  if (score || student.review || fields.some(field => field !== "receipt" && field !== "ownResponses")) {
    issue(["practice", "policy"], "原值确认只支持回执与本人获准作答");
  }
}

function validateAssessmentPolicy(
  practice: ReadingPublication["practice"], key: ReadingPublication["scoringKey"], registry: Registry, issue: Issue,
) {
  const { assessment } = practice.grading;
  const { passageScore, review, ownSubmission } = practice.policy.student;
  if (review && !passageScore) issue(["practice", "policy", "student", "review"], "开放复盘须声明整篇公布条件");
  if (Boolean(assessment) !== Boolean(key)) issue(["scoringKey"], "评分声明与固定评分键须成对提供");
  if (!assessment && (passageScore || ownSubmission.onFinal.length)) {
    issue(["practice", "policy", "student", "passageScore"], "公布成绩须声明评估槽位和规则");
  }
  if (assessment && key) validateKey(practice, assessment.keyRef, key, registry, issue);
}

function findSlot(steps: ReadonlyMap<string, ReadingStep>, reference: { stepId: string; slotId: string }) {
  const slots = steps.get(reference.stepId)?.submit.slots;
  return slots && Object.hasOwn(slots, reference.slotId) ? slots[reference.slotId] : undefined;
}

function validateKey(
  practice: ReadingPublication["practice"],
  reference: VersionRef,
  key: NonNullable<ReadingPublication["scoringKey"]>,
  registry: Registry,
  issue: Issue,
) {
  if (reference.id !== key.id || reference.version !== key.version) {
    issue(["practice", "grading", "assessment", "keyRef"], "评估引用的评分键版本与发布评分键不一致");
  }
  const [first] = practice.questions;
  const typeId = first && questionResponseType(registry, practice, first);
  const type = typeId === undefined ? undefined : registry.responseType(typeId);
  const values = type && wholePaperValues(key, type);
  const field = type?.wholePaperKey?.field;
  if (!type || !values || field === undefined) {
    issue(["scoringKey"], "评分键须与提交槽位类型一致");
    return;
  }
  const declaredFields = new Set(["id", "version", field]);
  for (const extra of Object.keys(key).filter(name => !declaredFields.has(name))) issue(["scoringKey", extra], "评分键含未声明的字段");
  const ids = new Set(practice.questions.map(question => question.id));
  for (const question of practice.questions) {
    if (wholePaperQuestionKey(key, type, question) === undefined) {
      issue(["scoringKey", field, question.id], "评分键须匹配本题的冻结形态与选项");
    }
  }
  for (const question of Object.keys(values)) {
    if (!ids.has(question)) issue(["scoringKey", field, question], "评分键引用的题目不存在");
  }
}
