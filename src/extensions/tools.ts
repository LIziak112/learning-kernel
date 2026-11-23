import type { ToolCapability } from "../contracts/capabilities.ts";

export const defaultTools: readonly ToolCapability[] = [
  { id: "text-selection", version: 1, requiredInputs: ["material"], optionalInputs: [], outputs: ["textRange"] },
  { id: "passage-select", version: 1, requiredInputs: ["material"], optionalInputs: [], outputs: ["passageSelection"] },
  {
    id: "single-choice-group", version: 1, requiredInputs: ["questions"],
    optionalInputs: ["material", "passageSelection", "oneChoicePerQuestion"], outputs: ["oneChoicePerQuestion"], supportsMaterialPositions: true,
    responseType: "choice",
  },
  { id: "response-group", version: 1, requiredInputs: ["questions"], optionalInputs: [], outputs: ["oneResponsePerQuestion"] },
  {
    id: "question-delivery", version: 1, requiredInputs: ["questions"], optionalInputs: ["material"], outputs: ["questionDelivery"],
    supportsMaterialPositions: true,
  },
];
