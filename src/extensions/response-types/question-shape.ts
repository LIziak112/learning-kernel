import type { QuestionDefinition, QuestionIssue } from "../../contracts/response-type.ts";

export function requireOptions(question: QuestionDefinition, issue: QuestionIssue) {
  if (Object.keys(question.options).length === 0) issue(["options"], "须冻结至少一个选项");
}

export function rejectOptions(question: QuestionDefinition, issue: QuestionIssue) {
  if (Object.keys(question.options).length > 0) issue(["options"], "此作答形态不使用选项");
}
