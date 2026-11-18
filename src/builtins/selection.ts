import type { Material, SaveInput, Step } from "../contracts/reading.ts";
import { selectionSchema } from "../contracts/reading.ts";
import { LearningError } from "../kernel/learning-error.ts";

export function selectText(material: Material, step: Step, range: SaveInput["range"]) {
  const paragraph = material.paragraphs.find(item => item.id === range.paragraphId);
  if (!paragraph || range.end > paragraph.text.length) {
    throw new LearningError(422, "INVALID_SELECTION");
  }
  const text = paragraph.text.slice(range.start, range.end);
  if (!text.trim()) throw new LearningError(422, "INVALID_SELECTION");
  return selectionSchema.parse({
    material: { id: material.id, version: material.version },
    positionId: step.positionId,
    range,
    text,
  });
}
