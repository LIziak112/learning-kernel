import { z } from "zod";
import { versionedChoiceDraftInput } from "./choice-draft.ts";
import type { ChoiceDraftScope } from "./choice-draft.ts";

export const choiceDraftAmendmentInput = versionedChoiceDraftInput.extend({ reason: z.string().trim().min(1).max(2000) });
export type ChoiceDraftAmendmentInput = z.infer<typeof choiceDraftAmendmentInput>;
export type ChoiceDraftAmendmentScope = ChoiceDraftScope;
export type AuthorizeChoiceDraftAmendment = (scope: Readonly<Omit<ChoiceDraftAmendmentScope, "protocolVersion"> & {
  reviewerId: string;
  studentId: string;
  activityId: string;
  action: "read" | "amend";
}>) => boolean;
