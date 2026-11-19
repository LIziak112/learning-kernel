import type { VersionRef } from "../contracts/reading.ts";

type StudentValue = "material" | "questions" | "textRange" | "passageSelection" | "oneChoicePerQuestion";
export type ValueType = StudentValue | "scoringKey" | "questionVerdict";

type ReadingCapability = Readonly<VersionRef> & (
  | {
    readonly audience: "student";
    readonly requiredInputs: readonly StudentValue[];
    readonly optionalInputs: readonly StudentValue[];
    readonly outputs: readonly StudentValue[];
  }
  | {
    readonly audience: "server";
    readonly requiredInputs: readonly ["oneChoicePerQuestion", "scoringKey"];
    readonly optionalInputs: readonly [];
    readonly outputs: readonly ["questionVerdict"];
  }
);

export const textSelectionCapability = {
  id: "text-selection",
  version: 1,
  audience: "student",
  requiredInputs: ["material"],
  optionalInputs: [],
  outputs: ["textRange"],
} as const satisfies ReadingCapability;

export const choiceKeyCapability = {
  id: "choice-key",
  version: 1,
  audience: "server",
  requiredInputs: ["oneChoicePerQuestion", "scoringKey"],
  optionalInputs: [],
  outputs: ["questionVerdict"],
} as const satisfies ReadingCapability;

const capabilities: readonly ReadingCapability[] = [
  textSelectionCapability,
  {
    id: "passage-select",
    version: 1,
    audience: "student",
    requiredInputs: ["material"],
    optionalInputs: [],
    outputs: ["passageSelection"],
  },
  {
    id: "single-choice-group",
    version: 1,
    audience: "student",
    requiredInputs: ["questions"],
    optionalInputs: ["material", "passageSelection", "oneChoicePerQuestion"],
    outputs: ["oneChoicePerQuestion"],
  },
  choiceKeyCapability,
];

export function readingCapability(reference: VersionRef) {
  return capabilities.find(capability => capability.id === reference.id && capability.version === reference.version);
}

export function isReservedReadingCapability(id: string) {
  return capabilities.some(capability => capability.id === id);
}

export function studentTool(reference: VersionRef) {
  const capability = readingCapability(reference);
  return capability?.audience === "student" ? capability : undefined;
}
