import { z } from "zod";
import { choiceDraftScope } from "./choice-draft.ts";
import { choiceDraftAmendmentInput } from "./choice-amendment.ts";
import { questionDeliveryDraftInput } from "./question-delivery.ts";
import { readingQuestion } from "./reading-publication.ts";

const reason = choiceDraftAmendmentInput.shape.reason;
const frozenIdentity = ["id", "version", "response"];

export const questionDeliveryAmendmentScope = choiceDraftScope;
export const questionDeliveryDraftAmendmentInput = questionDeliveryDraftInput.extend({ reason });
export const questionSnapshotContent = z.strictObject({
  question: readingQuestion.omit({ id: true, version: true, response: true })
    .refine(question => frozenIdentity.every(field => !Object.hasOwn(question, field)), "题号、版本与作答形态不可修改"),
  key: z.record(z.string(), z.json()).optional(),
});
export const questionDeliverySnapshotRevisionInput = choiceDraftAmendmentInput.omit({ choice: true })
  .extend(questionSnapshotContent.shape);

export type QuestionDeliveryAmendmentScope = z.infer<typeof questionDeliveryAmendmentScope>;
export type QuestionDeliveryDraftAmendmentInput = z.input<typeof questionDeliveryDraftAmendmentInput>;
export type QuestionDeliverySnapshotRevisionInput = z.input<typeof questionDeliverySnapshotRevisionInput>;
export type ParsedQuestionDeliverySnapshotRevision = z.infer<typeof questionDeliverySnapshotRevisionInput>;
export type ParsedQuestionDeliveryDraftAmendment = z.infer<typeof questionDeliveryDraftAmendmentInput>;
