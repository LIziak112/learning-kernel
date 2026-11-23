import type { QuestionDeliveryKey } from "../contracts/question-delivery.ts";
import type { VersionRef } from "../contracts/reading.ts";
import type { ReadingPublication, ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";
import type { Registry } from "./registry.ts";

type Issue = (path: (string | number)[], message: string) => void;
type Question = ReadingPublication["practice"]["questions"][number];
export type DeliverySlot = Extract<ReadingSlot, { type: "questionDelivery" }>;

export function questionDeliverySlot(step: ReadingStep) {
  return Object.entries(step.submit.slots).find((entry): entry is [string, DeliverySlot] => entry[1].type === "questionDelivery");
}

export function validateQuestionDeliveryPublication(publication: ReadingPublication, registry: Registry, issue: Issue) {
  const { practice } = publication;
  const delivery = locateDelivery(practice.steps);
  if (!delivery) {
    if (practice.questionAnswerRules !== undefined) {
      issue(["practice", "questionAnswerRules"], "题目已答规则须绑定逐题交付槽");
    }
    if (practice.grading.teacherReview) {
      issue(["practice", "grading", "teacherReview"], "教师评阅须绑定题组交付槽");
    }
    rejectUnboundQuestionFormats(practice.questions, issue);
    return false;
  }
  const { step, slotId } = delivery;
  const ids = new Set(practice.questions.map(question => question.id));
  validateDeliveryLocations(delivery, practice.steps.length, ids, issue);
  validateQuestionFormats(practice.questions, issue);
  validateAnswerRuleBindings(practice, registry, issue);
  validateDeliveryGrading(publication, { stepId: step.id, slotId }, ids, registry, issue);
  return true;
}

function validateDeliveryGrading(
  { practice, scoringKey }: ReadingPublication, output: Assessment["from"],
  ids: ReadonlySet<string>, registry: Registry, issue: Issue,
) {
  const { assessment, manualReview, teacherReview } = practice.grading;
  const teacherIds = new Set(teacherReview?.questionIds);
  validateTeacherReviewQuestions(teacherIds, ids, issue);
  if (manualReview) {
    if (assessment) issue(["practice", "grading", "manualReview"], "同一次题组交付只声明一种评估方式");
    if (teacherReview) issue(["practice", "grading", "teacherReview"], "教师评阅与整组人工评阅不能同时声明");
    validateManualReviewBasis(scoringKey, manualReview.keyRef, issue);
  } else if (assessment) {
    validateAutomaticQuestions(practice.questions.filter(({ id }) => !teacherIds.has(id)), scoringKey, assessment, output, ids, registry, issue);
  } else if (scoringKey) {
    issue(["practice", "grading", "assessment"], "冻结的评分依据须有对应的评估声明");
  }
}

function validateTeacherReviewQuestions(teacherIds: ReadonlySet<string>, ids: ReadonlySet<string>, issue: Issue) {
  for (const id of teacherIds) {
    if (!ids.has(id)) issue(["practice", "grading", "teacherReview", "questionIds"], "教师评阅须绑定已发布的题");
  }
}

function validateAutomaticQuestions(
  questions: readonly Question[], scoringKey: ReadingPublication["scoringKey"], assessment: Assessment, output: Assessment["from"],
  ids: ReadonlySet<string>, registry: Registry, issue: Issue,
) {
  if (!questions.length) issue(["practice", "grading", "assessment"], "自动评估须绑定至少一道题");
  const formats = new Set(questions.map(question => question.response).filter(format => format !== undefined));
  validateDeliveryAssessment(assessment, output, formats, registry, issue);
  if (validateDeliveryKey(scoringKey, assessment.keyRef, issue)) {
    validateQuestionKeys(questions, scoringKey.acceptedByQuestion, ids, registry, issue);
  }
}

function validateManualReviewBasis(key: ReadingPublication["scoringKey"], reference: VersionRef, issue: Issue) {
  if (!key || !("reviewCriteria" in key)) {
    issue(["scoringKey"], "人工评阅须提供实际冻结的评阅依据");
  } else if (key.id !== reference.id || key.version !== reference.version) {
    issue(["practice", "grading", "manualReview", "keyRef"], "人工评阅引用须指向本次冻结依据的精确版本");
  }
}

function validateAnswerRuleBindings(
  { questions, questionAnswerRules }: ReadingPublication["practice"], registry: Registry, issue: Issue,
) {
  if (!questionAnswerRules) return;
  for (const [questionId, reference] of Object.entries(questionAnswerRules)) {
    const path = ["practice", "questionAnswerRules", questionId];
    const question = questions.find(({ id }) => id === questionId);
    if (!question) issue(path, "已答规则须绑定已发布的题");
    else if (question.response === undefined || !registry.answerRule(reference, question.response)) {
      issue(path, "须注册与冻结题值形态匹配的精确已答规则版本");
    }
  }
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

function validateDeliveryKey(key: ReadingPublication["scoringKey"], reference: VersionRef, issue: Issue): key is DeliveryKey {
  if (!key || !("acceptedByQuestion" in key)) {
    issue(["scoringKey"], "逐题交付须提供按题冻结的评分键");
    return false;
  }
  if (key.id !== reference.id || key.version !== reference.version) {
    issue(["practice", "grading", "assessment", "keyRef"], "评估引用须指向本次冻结的评分键");
  }
  return true;
}

function validateQuestionFormats(questions: readonly Question[], issue: Issue) {
  for (const [index, { version, response }] of questions.entries()) {
    if (version === undefined) issue(["practice", "questions", index, "version"], "逐题交付须固定题版");
    if (!response) issue(["practice", "questions", index, "response"], "逐题交付须声明题的原值形态");
  }
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
  assessment: Assessment, output: Assessment["from"], formats: ReadonlySet<string>, registry: Registry, issue: Issue,
) {
  if (assessment.from.stepId !== output.stepId || assessment.from.slotId !== output.slotId) {
    issue(["practice", "grading", "assessment", "from"], "须绑定本组逐题交付的逻辑槽");
  }
  const covered = new Set(registry.evaluator(assessment.evaluator)?.responseTypes);
  for (const format of formats) {
    if (!covered.has(format)) {
      issue(["practice", "grading", "assessment", "evaluator"], `未注册 ${format} 所需的精确评估版本`);
    }
  }
}

function validateQuestionKeys(
  questions: readonly Question[], keys: Readonly<Record<string, QuestionDeliveryKey>>, ids: ReadonlySet<string>, registry: Registry, issue: Issue,
) {
  const pathFor = (id: string) => ["scoringKey", "acceptedByQuestion", id];
  for (const question of questions) {
    const key = Object.hasOwn(keys, question.id) ? keys[question.id] : undefined;
    if (!key || !keyMatchesQuestion(key, question, registry)) {
      issue(pathFor(question.id), "私有键须匹配本题的冻结形态、选项或空位");
    }
  }
  const automaticIds = new Set(questions.map(question => question.id));
  for (const id of Object.keys(keys)) {
    if (!ids.has(id)) issue(pathFor(id), "私有键引用了不存在的题");
    else if (!automaticIds.has(id)) issue(pathFor(id), "教师评阅题不得提供自动评分键");
  }
}

function keyMatchesQuestion({ response, ...key }: QuestionDeliveryKey, question: Question, registry: Registry) {
  if (response !== question.response) return false;
  return registry.responseType(response)?.parseKey?.(key, question) !== undefined;
}
