import { z } from "zod";
import type { ReadingPublication, ReadingSlot, ReadingStep } from "../contracts/reading-publication.ts";
import type { RegisteredResponseType } from "../contracts/response-type.ts";
import type { Registry } from "./registry.ts";

type Practice = ReadingPublication["practice"];
type Question = Practice["questions"][number];

const keyedValues = z.record(z.string(), z.unknown());

export function slotResponseType(registry: Registry, step: ReadingStep, slot: ReadingSlot): string | undefined {
  if (slot.type === "oneChoicePerQuestion") return registry.tool(step.tool)?.responseType;
  if (slot.type === "oneResponsePerQuestion") return slot.input;
  return undefined;
}

function impliedResponseType(registry: Registry, practice: Practice) {
  for (const step of practice.steps) {
    for (const slot of Object.values(step.submit.slots)) {
      const implied = slotResponseType(registry, step, slot);
      if (implied !== undefined) return implied;
    }
  }
  return undefined;
}

export function questionResponseType(registry: Registry, practice: Practice, question: Question) {
  return question.response ?? impliedResponseType(registry, practice);
}

export function frozenResponseType(registry: Registry, practice: Practice, question: Question): RegisteredResponseType {
  const id = questionResponseType(registry, practice, question);
  if (id === undefined) throw new Error("冻结的题缺少作答形态");
  return registry.requireResponseType(id);
}

export function wholePaperValues(key: object, type: RegisteredResponseType) {
  const field = type.wholePaperKey?.field;
  if (field === undefined || !Object.hasOwn(key, field)) return undefined;
  return keyedValues.parse(Reflect.get(key, field));
}

export function wholePaperQuestionKey(key: object, type: RegisteredResponseType, question: Question) {
  const values = wholePaperValues(key, type);
  const layout = type.wholePaperKey;
  if (!values || !layout || !Object.hasOwn(values, question.id)) return undefined;
  return type.parseKey?.(layout.toKey(values[question.id]), question);
}
