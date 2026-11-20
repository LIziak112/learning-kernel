import { z } from "zod";
import { choiceConfirmationInput, confirmationKey } from "./contracts/choice-confirmation.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, VerifyOriginal } from "./contracts/choice-confirmation.ts";
import { choiceDraftAmendmentInput } from "./contracts/choice-amendment.ts";
import type { AuthorizeChoiceDraftAmendment, ChoiceDraftAmendmentInput, ChoiceDraftAmendmentScope } from "./contracts/choice-amendment.ts";
import { choiceDraftScope, choiceDraftInput, currentChoiceDraftMode } from "./contracts/choice-draft.ts";
import type { ChoiceDraftInput, CurrentChoiceDraftMode, UnversionedChoiceDraftInput } from "./contracts/choice-draft.ts";
import { choiceEvaluators } from "./contracts/choice-evaluation.ts";
import { choiceSnapshotRevisionInput } from "./contracts/choice-snapshot.ts";
import type { AuthorizeChoiceSnapshotRevision, ChoiceSnapshotRevisionInput, ChoiceSnapshotReviewerScope, HasChoiceSnapshotEvidence } from "./contracts/choice-snapshot.ts";
import { preparedVersionInput } from "./contracts/prepared-activity.ts";
import type { PreparedActivityVersionInput, PreparedActivityVersionReceipt } from "./contracts/prepared-activity.ts";
import { id, publicationSchema, startInput, versionRef } from "./contracts/reading.ts";
import { readingPublicationSchema } from "./contracts/reading-publication.ts";
import { responseDraftInput } from "./contracts/response.ts";
import type { ResponseConfirmationInput, ResponseDraftInput } from "./contracts/response.ts";
import { responseEvaluators } from "./contracts/response-evaluation.ts";
import { startActivity } from "./kernel/activity.ts";
import { amendChoiceDraft, readChoiceDraftForAmendment } from "./kernel/choice-amendment.ts";
import { confirmChoices, recoverChoiceConfirmation } from "./kernel/choice-confirmation.ts";
import { readChoiceDraftActivity } from "./kernel/choice-draft-activity.ts";
import { saveChoiceDraft, saveCurrentChoiceDraft } from "./kernel/choice-drafts.ts";
import { reviseChoiceSnapshot } from "./kernel/choice-snapshot.ts";
import { openDatabase, readTransaction } from "./kernel/database.ts";
import { LearningError } from "./kernel/learning-error.ts";
import { replacePreparedActivityVersion } from "./kernel/prepared-activity.ts";
import { registerPublication } from "./kernel/publication.ts";
import { confirmResponses, recoverResponseConfirmation } from "./kernel/response-confirmation.ts";
import { saveResponseDraft } from "./kernel/response-drafts.ts";
import { readActivity } from "./kernel/submission.ts";

const runtimeOptions = z.strictObject({
  databasePath: z.string().min(1),
  choiceEvaluators: choiceEvaluators.default([]),
  responseEvaluators: responseEvaluators.default([]),
  authorizeChoiceDraftAmendment: z.custom<AuthorizeChoiceDraftAmendment>(value => typeof value === "function").optional(),
  authorizeChoiceSnapshotRevision: z.custom<AuthorizeChoiceSnapshotRevision>(value => typeof value === "function").optional(),
  hasChoiceSnapshotEvidence: z.custom<HasChoiceSnapshotEvidence>(value => typeof value === "function").optional(),
  verifyOriginal: z.custom<VerifyOriginal>(value => typeof value === "function").optional(),
  authorizeConfirmationRecovery: z.custom<AuthorizeConfirmationRecovery>(value => typeof value === "function").optional(),
});
const studentPrincipal = z.strictObject({ role: z.literal("student"), id });
const reviewerPrincipal = z.strictObject({ role: z.literal("reviewer"), id });
const publishedStartInput = startInput.extend({ practiceVersion: versionRef.shape.version });
const uuid = z.uuid();
const clock = () => new Date();

export { LearningError };
export { verifyActivityBindings } from "./kernel/activity-bindings.ts";
export type { AuthorizeChoiceSnapshotRevision, ChoiceSnapshotRevisionInput, ChoiceSnapshotReviewerScope, HasChoiceSnapshotEvidence };
export type { AuthorizeChoiceDraftAmendment, ChoiceDraftAmendmentInput, ChoiceDraftAmendmentScope };
export type ReviewerPrincipal = z.input<typeof reviewerPrincipal>;
export type { ActivityBindingClaims, TeacherAmendmentBinding, TeacherAmendmentBindingClaims } from "./contracts/activity-bindings.ts";
export type { PreparedActivityVersionInput, PreparedActivityVersionReceipt };
export type { ChoiceEvaluationInput, ChoiceEvaluator, ChoiceEvaluatorRegistration } from "./contracts/choice-evaluation.ts";
export { ChoiceConfirmationConflict } from "./kernel/choice-confirmation.ts";
export type { ChoiceDraftActivity } from "./kernel/choice-draft-activity.ts";
export { ChoiceSnapshotRevisionConflict } from "./kernel/choice-snapshot.ts";
export { ChoiceDraftConflict } from "./kernel/choice-drafts.ts";
export { ResponseConfirmationConflict } from "./kernel/response-confirmation.ts";
export { ResponseDraftConflict } from "./kernel/response-drafts.ts";
export type { ResponseConfirmation, ResponseConfirmationInput, ResponseDraftInput, ResponseValue } from "./contracts/response.ts";
export type { ResponseEvaluationInput, ResponseEvaluator, ResponseEvaluatorRegistration, ResponseVerdict } from "./contracts/response-evaluation.ts";
export type { ChoiceDraftInput, AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, CurrentChoiceDraftMode, UnversionedChoiceDraftInput, VerifyOriginal };
export type PublicationInput = z.input<typeof publicationSchema> | z.input<typeof readingPublicationSchema>;
export type StudentPrincipal = z.input<typeof studentPrincipal>;
export type PublishedStartInput = z.input<typeof publishedStartInput>;
export type StudentActivity = ReturnType<typeof readActivity>;

function principalId(schema: z.ZodType<{ id: string }>, principal: unknown) {
  const parsed = schema.safeParse(principal);
  if (!parsed.success) throw new LearningError(403, "FORBIDDEN");
  return parsed.data.id;
}

export function openLearningRuntime(options: z.input<typeof runtimeOptions>) {
  const settings = runtimeOptions.parse(options);
  const database = openDatabase(settings.databasePath);
  return {
    publish(input: PublicationInput) {
      registerPublication(database, input, settings.choiceEvaluators, settings.responseEvaluators);
    },
    start(principal: StudentPrincipal, input: PublishedStartInput) {
      return startActivity(database, principalId(studentPrincipal, principal), publishedStartInput.parse(input), clock);
    },
    prepare(principal: StudentPrincipal, input: PublishedStartInput) {
      return startActivity(database, principalId(studentPrincipal, principal), publishedStartInput.parse(input), clock, undefined, "prepare");
    },
    replacePreparedActivityVersion(
      principal: StudentPrincipal, activityId: string, input: PreparedActivityVersionInput,
    ): PreparedActivityVersionReceipt {
      return replacePreparedActivityVersion(database, principalId(studentPrincipal, principal), uuid.parse(activityId), preparedVersionInput.parse(input));
    },
    read(principal: StudentPrincipal, activityId: string): StudentActivity {
      return readTransaction(database, () => readActivity(database, principalId(studentPrincipal, principal), uuid.parse(activityId)));
    },
    readChoiceDraftActivity(principal: StudentPrincipal, activityId: string) {
      return readChoiceDraftActivity(database, principalId(studentPrincipal, principal), uuid.parse(activityId));
    },
    saveChoiceDraft(principal: StudentPrincipal, activityId: string, input: ChoiceDraftInput | UnversionedChoiceDraftInput) {
      return saveChoiceDraft(database, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceDraftInput.parse(input), clock);
    },
    saveCurrentChoiceDraft(
      principal: StudentPrincipal, activityId: string, input: ChoiceDraftInput | UnversionedChoiceDraftInput, mode: CurrentChoiceDraftMode = "save",
    ) {
      return saveCurrentChoiceDraft(database, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceDraftInput.parse(input),
        currentChoiceDraftMode.parse(mode), clock);
    },
    readChoiceDraftForAmendment(principal: ReviewerPrincipal, activityId: string, scope: ChoiceDraftAmendmentScope) {
      return readChoiceDraftForAmendment(database, principalId(reviewerPrincipal, principal), uuid.parse(activityId), choiceDraftScope.parse(scope),
        settings.authorizeChoiceDraftAmendment);
    },
    amendChoiceDraft(principal: ReviewerPrincipal, activityId: string, input: ChoiceDraftAmendmentInput) {
      return amendChoiceDraft(database, principalId(reviewerPrincipal, principal), uuid.parse(activityId), choiceDraftAmendmentInput.parse(input),
        clock, settings.authorizeChoiceDraftAmendment);
    },
    reviseChoiceSnapshot(principal: ReviewerPrincipal, activityId: string, input: ChoiceSnapshotRevisionInput) {
      return reviseChoiceSnapshot(database, principalId(reviewerPrincipal, principal), uuid.parse(activityId),
        choiceSnapshotRevisionInput.parse(input), clock, {
          authorize: settings.authorizeChoiceSnapshotRevision, hasEvidence: settings.hasChoiceSnapshotEvidence,
        });
    },
    confirmChoices(principal: StudentPrincipal, activityId: string, input: ChoiceConfirmationInput) {
      return confirmChoices(database, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceConfirmationInput.parse(input),
        clock, settings.verifyOriginal);
    },
    recoverChoiceConfirmation(principal: StudentPrincipal, activityId: string, key: ConfirmationKey) {
      return recoverChoiceConfirmation(database, principalId(studentPrincipal, principal), uuid.parse(activityId), confirmationKey.parse(key),
        settings.authorizeConfirmationRecovery, settings.choiceEvaluators);
    },
    saveResponseDraft(
      principal: StudentPrincipal, activityId: string, input: ResponseDraftInput, mode: CurrentChoiceDraftMode = "save",
    ) {
      return saveResponseDraft(database, principalId(studentPrincipal, principal), uuid.parse(activityId), responseDraftInput.parse(input),
        currentChoiceDraftMode.parse(mode), clock);
    },
    confirmResponses(principal: StudentPrincipal, activityId: string, input: ResponseConfirmationInput) {
      return confirmResponses(database, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceConfirmationInput.parse(input),
        clock, settings.verifyOriginal);
    },
    recoverResponseConfirmation(principal: StudentPrincipal, activityId: string, key: ConfirmationKey) {
      return recoverResponseConfirmation(database, principalId(studentPrincipal, principal), uuid.parse(activityId), confirmationKey.parse(key),
        settings.authorizeConfirmationRecovery, settings.responseEvaluators);
    },
    close() {
      database.close();
    },
  };
}
