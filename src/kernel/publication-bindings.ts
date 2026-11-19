import { readingCapability, studentTool } from "../builtins/reading-capabilities.ts";
import type { ValueType } from "../builtins/reading-capabilities.ts";
import type { ReadingPublication, ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";

type Issue = (path: (string | number)[], message: string) => void;

export function validateBindings({ practice, scoringKey }: ReadingPublication, issue: Issue) {
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
    earlierSteps.set(step.id, step);
  }
  validateGrading(practice.grading, earlierSteps, issue);
  validateAssessmentPolicy(practice, scoringKey, issue);
  validateQuestions(practice, issue);
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
    case "oneChoicePerQuestion": return input === "questions";
    case "reuse": return input === "passageSelection" || input === "oneChoicePerQuestion";
  }
}

function validateGrading(
  grading: ReadingPublication["practice"]["grading"],
  steps: ReadonlyMap<string, ReadingStep>,
  issue: Issue,
) {
  const { selectionFeedback, assessment } = grading;
  if (selectionFeedback && findSlot(steps, selectionFeedback.from)?.type !== "passageSelection") {
    issue(["practice", "grading", "selectionFeedback", "from"], "评语须绑定选区交付槽位");
  }
  if (!assessment) return;
  const submittedType = findSlot(steps, assessment.from)?.type;
  if (submittedType !== "oneChoicePerQuestion") {
    issue(["practice", "grading", "assessment", "from"], "逐题评估须绑定单选交付槽位");
  }
  if (readingCapability(assessment.evaluator)?.audience !== "server") {
    issue(["practice", "grading", "assessment", "evaluator"], "须绑定获准读取评分键并输出逐题判定的服务端评估器");
  }
}

function validateAssessmentPolicy(practice: ReadingPublication["practice"], key: ReadingPublication["scoringKey"], issue: Issue) {
  const { assessment } = practice.grading;
  const { passageScore, review, ownSubmission } = practice.policy.student;
  if (review && !passageScore) issue(["practice", "policy", "student", "review"], "开放复盘须声明整篇公布条件");
  if (Boolean(assessment) !== Boolean(key)) issue(["scoringKey"], "评分声明与固定评分键须成对提供");
  if (!assessment && (passageScore || ownSubmission.onFinal.length)) {
    issue(["practice", "policy", "student", "passageScore"], "公布成绩须声明评估槽位和规则");
  }
  if (assessment && key) validateKey(practice, assessment.keyRef, key, issue);
}

function findSlot(steps: ReadonlyMap<string, ReadingStep>, reference: { stepId: string; slotId: string }) {
  const slots = steps.get(reference.stepId)?.submit.slots;
  return slots && Object.hasOwn(slots, reference.slotId) ? slots[reference.slotId] : undefined;
}

function validateKey(
  practice: ReadingPublication["practice"],
  reference: { id: string; version: number },
  key: NonNullable<ReadingPublication["scoringKey"]>,
  issue: Issue,
) {
  if (reference.id !== key.id || reference.version !== key.version) {
    issue(["practice", "grading", "assessment", "keyRef"], "评估引用的评分键版本与发布评分键不一致");
  }
  const questions = new Set(practice.questions.map(question => question.id));
  for (const question of practice.questions) {
    const answer = key.acceptedChoices[question.id];
    if (answer === undefined || !Object.hasOwn(question.options, answer)) {
      issue(["scoringKey", "acceptedChoices", question.id], "评分键须指向本题存在的选项");
    }
  }
  for (const question of Object.keys(key.acceptedChoices)) {
    if (!questions.has(question)) issue(["scoringKey", "acceptedChoices", question], "评分键引用的题目不存在");
  }
}
