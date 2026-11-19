import { z } from "zod";
import { choiceConfirmationInput, confirmationKey } from "./contracts/choice-confirmation.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, VerifyOriginal } from "./contracts/choice-confirmation.ts";
import { choiceDraftInput, currentChoiceDraftMode } from "./contracts/choice-draft.ts";
import type { ChoiceDraftInput, CurrentChoiceDraftMode, UnversionedChoiceDraftInput } from "./contracts/choice-draft.ts";
import { choiceEvaluators } from "./contracts/choice-evaluation.ts";
import { preparedVersionInput } from "./contracts/prepared-activity.ts";
import type { PreparedActivityVersionInput, PreparedActivityVersionReceipt } from "./contracts/prepared-activity.ts";
import { id, publicationSchema, startInput, versionRef } from "./contracts/reading.ts";
import { readingPublicationSchema } from "./contracts/reading-publication.ts";
import { startActivity } from "./kernel/activity.ts";
import { confirmChoices, recoverChoiceConfirmation } from "./kernel/choice-confirmation.ts";
import { readChoiceDraftActivity } from "./kernel/choice-draft-activity.ts";
import { saveChoiceDraft, saveCurrentChoiceDraft } from "./kernel/choice-drafts.ts";
import { openDatabase, readTransaction } from "./kernel/database.ts";
import { LearningError } from "./kernel/learning-error.ts";
import { replacePreparedActivityVersion } from "./kernel/prepared-activity.ts";
import { registerPublication } from "./kernel/publication.ts";
import { readActivity } from "./kernel/submission.ts";

const runtimeOptions = z.strictObject({
  databasePath: z.string().min(1),
  choiceEvaluators: choiceEvaluators.default([]),
  verifyOriginal: z.custom<VerifyOriginal>(value => typeof value === "function").optional(),
  authorizeConfirmationRecovery: z.custom<AuthorizeConfirmationRecovery>(value => typeof value === "function").optional(),
});
const studentPrincipal = z.strictObject({ role: z.literal("student"), id });
const publishedStartInput = startInput.extend({ practiceVersion: versionRef.shape.version });
const uuid = z.uuid();
const clock = () => new Date();

export { LearningError };
export { verifyActivityBindings } from "./kernel/activity-bindings.ts";
export type { ActivityBindingClaims } from "./contracts/activity-bindings.ts";
export type { PreparedActivityVersionInput, PreparedActivityVersionReceipt };
export type { ChoiceEvaluationInput, ChoiceEvaluator, ChoiceEvaluatorRegistration } from "./contracts/choice-evaluation.ts";
export { ChoiceConfirmationConflict } from "./kernel/choice-confirmation.ts";
export type { ChoiceDraftActivity } from "./kernel/choice-draft-activity.ts";
export { ChoiceDraftConflict } from "./kernel/choice-drafts.ts";
export type { ChoiceDraftInput, AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, CurrentChoiceDraftMode, UnversionedChoiceDraftInput, VerifyOriginal };
export type PublicationInput = z.input<typeof publicationSchema> | z.input<typeof readingPublicationSchema>;
export type StudentPrincipal = z.input<typeof studentPrincipal>;
export type PublishedStartInput = z.input<typeof publishedStartInput>;
export type StudentActivity = ReturnType<typeof readActivity>;

function studentId(principal: StudentPrincipal) {
  const parsed = studentPrincipal.safeParse(principal);
  if (!parsed.success) throw new LearningError(403, "FORBIDDEN");
  return parsed.data.id;
}

export function openLearningRuntime(options: z.input<typeof runtimeOptions>) {
  const settings = runtimeOptions.parse(options);
  const database = openDatabase(settings.databasePath);
  return {
    publish(input: PublicationInput) {
      registerPublication(database, input, settings.choiceEvaluators);
    },
    start(principal: StudentPrincipal, input: PublishedStartInput) {
      return startActivity(database, studentId(principal), publishedStartInput.parse(input), clock);
    },
    prepare(principal: StudentPrincipal, input: PublishedStartInput) {
      return startActivity(database, studentId(principal), publishedStartInput.parse(input), clock, undefined, "prepare");
    },
    replacePreparedActivityVersion(
      principal: StudentPrincipal, activityId: string, input: PreparedActivityVersionInput,
    ): PreparedActivityVersionReceipt {
      return replacePreparedActivityVersion(database, studentId(principal), uuid.parse(activityId), preparedVersionInput.parse(input));
    },
    read(principal: StudentPrincipal, activityId: string): StudentActivity {
      return readTransaction(database, () => readActivity(database, studentId(principal), uuid.parse(activityId)));
    },
    readChoiceDraftActivity(principal: StudentPrincipal, activityId: string) {
      return readChoiceDraftActivity(database, studentId(principal), uuid.parse(activityId));
    },
    saveChoiceDraft(principal: StudentPrincipal, activityId: string, input: ChoiceDraftInput | UnversionedChoiceDraftInput) {
      return saveChoiceDraft(database, studentId(principal), uuid.parse(activityId), choiceDraftInput.parse(input), clock);
    },
    saveCurrentChoiceDraft(
      principal: StudentPrincipal, activityId: string, input: ChoiceDraftInput | UnversionedChoiceDraftInput, mode: CurrentChoiceDraftMode = "save",
    ) {
      return saveCurrentChoiceDraft(database, studentId(principal), uuid.parse(activityId), choiceDraftInput.parse(input),
        currentChoiceDraftMode.parse(mode), clock);
    },
    confirmChoices(principal: StudentPrincipal, activityId: string, input: ChoiceConfirmationInput) {
      return confirmChoices(database, studentId(principal), uuid.parse(activityId), choiceConfirmationInput.parse(input),
        clock, settings.verifyOriginal);
    },
    recoverChoiceConfirmation(principal: StudentPrincipal, activityId: string, key: ConfirmationKey) {
      return recoverChoiceConfirmation(database, studentId(principal), uuid.parse(activityId), confirmationKey.parse(key),
        settings.authorizeConfirmationRecovery, settings.choiceEvaluators);
    },
    close() {
      database.close();
    },
  };
}
