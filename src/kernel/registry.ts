import type { ToolCapability } from "../contracts/capabilities.ts";
import type { EvaluatorRegistration, QuestionAnswerRule } from "../contracts/evaluator.ts";
import { LearningError } from "../contracts/learning-error.ts";
import type { VersionRef } from "../contracts/reading.ts";
import type { RegisteredResponseType } from "../contracts/response-type.ts";

export type Extensions = Readonly<{
  tools: readonly ToolCapability[];
  responseTypes: readonly RegisteredResponseType[];
  evaluators: readonly EvaluatorRegistration[];
  answerRules: readonly QuestionAnswerRule[];
}>;

export type Registry = Readonly<{
  tool(reference: VersionRef): ToolCapability | undefined;
  responseType(id: string): RegisteredResponseType | undefined;
  requireResponseType(id: string): RegisteredResponseType;
  evaluator(reference: VersionRef): EvaluatorRegistration | undefined;
  answerRule(reference: VersionRef, responseType: string): QuestionAnswerRule | undefined;
}>;

const identity = ({ id, version }: VersionRef) => JSON.stringify([id, version]);

function unique<T>(entries: readonly T[], key: (entry: T) => string, label: string) {
  const indexed = new Map<string, T>();
  for (const entry of entries) {
    const name = key(entry);
    if (indexed.has(name)) throw new Error(`${label}重复登记：${name}`);
    indexed.set(name, entry);
  }
  return indexed;
}

export function createRegistry({ tools, responseTypes, evaluators, answerRules }: Extensions): Registry {
  const toolIndex = unique(tools, identity, "工具");
  const typeIndex = unique(responseTypes, ({ id }) => id, "作答形态");
  const evaluatorIndex = unique(evaluators, identity, "评估器");
  const ruleIndex = unique(answerRules, identity, "已答规则");
  for (const { id, responseTypes: covered } of evaluators) {
    const missing = covered.find(type => !typeIndex.has(type));
    if (missing !== undefined) throw new Error(`评估器 ${id} 引用了未登记的作答形态：${missing}`);
  }
  for (const { id, responseType } of answerRules) {
    if (!typeIndex.has(responseType)) throw new Error(`已答规则 ${id} 引用了未登记的作答形态：${responseType}`);
  }
  return {
    tool: reference => toolIndex.get(identity(reference)),
    responseType: id => typeIndex.get(id),
    requireResponseType(id) {
      const type = typeIndex.get(id);
      if (!type) throw new LearningError(503, "RESPONSE_TYPE_UNAVAILABLE");
      return type;
    },
    evaluator: reference => evaluatorIndex.get(identity(reference)),
    answerRule(reference, responseType) {
      const rule = ruleIndex.get(identity(reference));
      return rule?.responseType === responseType ? rule : undefined;
    },
  };
}
