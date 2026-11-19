import { z } from "zod";
import { choiceConfirmationInput, confirmationKey } from "./contracts/choice-confirmation.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, VerifyOriginal } from "./contracts/choice-confirmation.ts";
import { choiceDraftInput } from "./contracts/choice-draft.ts";
import type { ChoiceDraftInput, UnversionedChoiceDraftInput } from "./contracts/choice-draft.ts";
import { id, publicationSchema, startInput, versionRef } from "./contracts/reading.ts";
import { readingPublicationSchema } from "./contracts/reading-publication.ts";
import { startActivity } from "./kernel/activity.ts";
import { confirmChoices, recoverChoiceConfirmation } from "./kernel/choice-confirmation.ts";
import { saveChoiceDraft } from "./kernel/choice-drafts.ts";
import { openDatabase } from "./kernel/database.ts";
import { LearningError } from "./kernel/learning-error.ts";
import { registerPublication } from "./kernel/publication.ts";
import { readActivity } from "./kernel/submission.ts";

const runtimeOptions = z.strictObject({
  databasePath: z.string().min(1),
  verifyOriginal: z.custom<VerifyOriginal>(value => typeof value === "function").optional(),
  authorizeConfirmationRecovery: z.custom<AuthorizeConfirmationRecovery>(value => typeof value === "function").optional(),
});
const studentPrincipal = z.strictObject({ role: z.literal("student"), id });
const publishedStartInput = startInput.extend({ practiceVersion: versionRef.shape.version });
const uuid = z.uuid();

export { LearningError };
export { ChoiceConfirmationConflict } from "./kernel/choice-confirmation.ts";
export { ChoiceDraftConflict } from "./kernel/choice-drafts.ts";
export type { ChoiceDraftInput, AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, UnversionedChoiceDraftInput, VerifyOriginal };
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
      registerPublication(database, input);
    },
    start(principal: StudentPrincipal, input: PublishedStartInput) {
      return startActivity(database, studentId(principal), publishedStartInput.parse(input), () => new Date());
    },
    read(principal: StudentPrincipal, activityId: string): StudentActivity {
      return readActivity(database, studentId(principal), uuid.parse(activityId));
    },
    saveChoiceDraft(principal: StudentPrincipal, activityId: string, input: ChoiceDraftInput | UnversionedChoiceDraftInput) {
      return saveChoiceDraft(database, studentId(principal), uuid.parse(activityId), choiceDraftInput.parse(input));
    },
    confirmChoices(principal: StudentPrincipal, activityId: string, input: ChoiceConfirmationInput) {
      return confirmChoices(database, studentId(principal), uuid.parse(activityId), choiceConfirmationInput.parse(input),
        () => new Date(), settings.verifyOriginal);
    },
    recoverChoiceConfirmation(principal: StudentPrincipal, activityId: string, key: ConfirmationKey) {
      return recoverChoiceConfirmation(database, studentId(principal), uuid.parse(activityId), confirmationKey.parse(key),
        settings.authorizeConfirmationRecovery);
    },
    close() {
      database.close();
    },
  };
}
