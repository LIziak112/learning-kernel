import { z } from "zod";
import type { ChoiceReviewerScope } from "./choice-amendment.ts";
import { choiceDraftAmendmentInput } from "./choice-amendment.ts";
import { id, versionRef } from "./reading.ts";
import { readingQuestion } from "./reading-publication.ts";

export const choiceSnapshotContent = readingQuestion.pick({ prompt: true, options: true }).extend({ acceptedChoice: id });
export const choiceSnapshotRevisionInput = choiceDraftAmendmentInput.omit({ choice: true }).extend(choiceSnapshotContent.shape);
export type ChoiceSnapshotRevisionInput = z.infer<typeof choiceSnapshotRevisionInput>;
export type ChoiceSnapshotReviewerScope = ChoiceReviewerScope & Readonly<{ baseRevision: number; operationId: string }>;
export type AuthorizeChoiceSnapshotRevision = (scope: ChoiceSnapshotReviewerScope) => boolean;
export type HasChoiceSnapshotEvidence = (scope: ChoiceSnapshotReviewerScope) => boolean;

export const choiceSnapshotRevision = z.strictObject({
  slotId: id, questionId: id, questionVersion: versionRef.shape.version, revision: z.int().positive(),
});
