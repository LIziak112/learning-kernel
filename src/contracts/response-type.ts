import type { VersionRef } from "./reading.ts";

export type QuestionDefinition = Readonly<Record<string, unknown>> & Readonly<{
  id: string;
  version?: number | undefined;
  prompt: string;
  options: Readonly<Record<string, string>>;
  response?: string | undefined;
}>;

export type QuestionIssue = (path: readonly (string | number)[], message: string) => void;

export type ResponseType<Value, Key> = Readonly<VersionRef> & {
  readonly config?: readonly string[];
  validateQuestion(question: QuestionDefinition, issue: QuestionIssue): void;
  parseValue(value: unknown, question: QuestionDefinition): Value;
  isAnswered(value: Value, question: QuestionDefinition): boolean;
  parseKey?(key: unknown, question: QuestionDefinition): Key | undefined;
  wholePaperKey?: Readonly<{ field: string; toKey(value: unknown): unknown }>;
};

export type RegisteredResponseType = Readonly<VersionRef> & {
  readonly config: readonly string[];
  validateQuestion(question: QuestionDefinition, issue: QuestionIssue): void;
  parseValue(value: unknown, question: QuestionDefinition): unknown;
  isAnswered(value: unknown, question: QuestionDefinition): boolean;
  parseKey: ((key: unknown, question: QuestionDefinition) => unknown) | undefined;
  wholePaperKey: Readonly<{ field: string; toKey(value: unknown): unknown }> | undefined;
};

export function defineResponseType<Value, Key>(type: ResponseType<Value, Key>): RegisteredResponseType {
  const { id, version, config = [], wholePaperKey } = type;
  const parseKey = type.parseKey;
  return {
    id, version, config, wholePaperKey,
    validateQuestion: (question, issue) => type.validateQuestion(question, issue),
    parseValue: (value, question) => type.parseValue(value, question),
    isAnswered: (value, question) => type.isAnswered(type.parseValue(value, question), question),
    parseKey: parseKey && ((key, question) => parseKey(key, question)),
  };
}
