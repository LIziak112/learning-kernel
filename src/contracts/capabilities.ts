import type { VersionRef } from "./reading.ts";

export type StudentValue =
  | "material" | "questions" | "textRange" | "passageSelection" | "oneChoicePerQuestion" | "oneResponsePerQuestion" | "questionDelivery";

export type ToolCapability = Readonly<VersionRef> & {
  readonly requiredInputs: readonly StudentValue[];
  readonly optionalInputs: readonly StudentValue[];
  readonly outputs: readonly StudentValue[];
  readonly supportsMaterialPositions?: boolean;
  readonly responseType?: string;
};
