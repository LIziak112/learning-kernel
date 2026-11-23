import { z } from "zod";
import { choiceConfirmationInput, confirmationKey } from "./contracts/choice-confirmation.ts";
import type { AuthorizeConfirmationRecovery, ChoiceConfirmationInput, ConfirmationKey, VerifyOriginal } from "./contracts/choice-confirmation.ts";
import { choiceDraftAmendmentInput } from "./contracts/choice-amendment.ts";
import type { AuthorizeChoiceDraftAmendment, ChoiceDraftAmendmentInput, ChoiceDraftAmendmentScope } from "./contracts/choice-amendment.ts";
import { choiceDraftScope, choiceDraftInput, currentChoiceDraftMode } from "./contracts/choice-draft.ts";
import type { ChoiceDraftInput, CurrentChoiceDraftMode, UnversionedChoiceDraftInput } from "./contracts/choice-draft.ts";
import { choiceSnapshotRevisionInput } from "./contracts/choice-snapshot.ts";
import type { AuthorizeChoiceSnapshotRevision, ChoiceSnapshotRevisionInput, ChoiceSnapshotReviewerScope, HasChoiceSnapshotEvidence } from "./contracts/choice-snapshot.ts";
import { questionDeliveryDraftInput, questionDeliveryInput, questionDeliveryReviewMode } from "./contracts/question-delivery.ts";
import type { QuestionDeliveryDraftInput, QuestionDeliveryInput } from "./contracts/question-delivery.ts";
import { frozenConfirmationVerdictMode, verdictCommand } from "./contracts/verdict.ts";
import type { AuthorizeReview, FrozenConfirmationVerdictMode, VerdictCommand } from "./contracts/verdict.ts";
import { preparedVersionInput } from "./contracts/prepared-activity.ts";
import type { PreparedActivityVersionInput, PreparedActivityVersionReceipt } from "./contracts/prepared-activity.ts";
import { id, publicationSchema, startInput, versionRef } from "./contracts/reading.ts";
import { readingPublicationSchema } from "./contracts/reading-publication.ts";
import type { ToolCapability } from "./contracts/capabilities.ts";
import type { Evaluator, EvaluatorRegistration, QuestionAnswerRule } from "./contracts/evaluator.ts";
import { responseDraftInput } from "./contracts/response.ts";
import type { ResponseConfirmationInput, ResponseDraftInput } from "./contracts/response.ts";
import type { RegisteredResponseType } from "./contracts/response-type.ts";
import { defaultEvaluators, defaultResponseTypes, defaultTools } from "./extensions/index.ts";
import { startActivity } from "./kernel/activity.ts";
import { amendChoiceDraft, readChoiceDraftForAmendment } from "./kernel/choice-amendment.ts";
import { confirmChoices, recoverChoiceConfirmation } from "./kernel/choice-confirmation.ts";
import { readChoiceDraftActivity } from "./kernel/choice-draft-activity.ts";
import { saveChoiceDraft, saveCurrentChoiceDraft } from "./kernel/choice-drafts.ts";
import { reviseChoiceSnapshot } from "./kernel/choice-snapshot.ts";
import { openDatabase, readTransaction } from "./kernel/database.ts";
import { LearningError } from "./contracts/learning-error.ts";
import { replacePreparedActivityVersion } from "./kernel/prepared-activity.ts";
import { confirmQuestionDelivery, recoverQuestionDelivery } from "./kernel/question-delivery-confirmation.ts";
import {
  readChoiceConfirmationVerdicts, readQuestionDeliveryReview, readQuestionDeliveryVerdicts, readResponseConfirmationVerdicts, writeQuestionDeliveryVerdict,
} from "./kernel/question-delivery-review.ts";
import { saveQuestionDeliveryDraft } from "./kernel/question-delivery-drafts.ts";
import { registerPublication } from "./kernel/publication.ts";
import { evaluatePending } from "./kernel/pending-evaluation.ts";
import type { EvaluationSummary } from "./kernel/pending-evaluation.ts";
import { createRegistry } from "./kernel/registry.ts";
import type { RuntimeCheckpoint } from "./kernel/runtime-checkpoint.ts";
import { readingEntries } from "./runtime/reading.ts";
import { confirmResponses, recoverResponseConfirmation } from "./kernel/response-confirmation.ts";
import { saveResponseDraft } from "./kernel/response-drafts.ts";
import { readActivity } from "./kernel/submission.ts";

const callable = <T>() => z.custom<T>(value => typeof value === "function");
const evaluatorShape = versionRef.extend({ responseTypes: z.array(id).min(1), evaluate: callable<Evaluator>() });
const evaluatorRegistration = z.custom<EvaluatorRegistration>(value => evaluatorShape.safeParse(value).success);
const answerRuleShape = versionRef.extend({ responseType: id, isAnswered: callable<QuestionAnswerRule["isAnswered"]>() });
const answerRuleRegistration = z.custom<QuestionAnswerRule>(value => answerRuleShape.safeParse(value).success);
const optionalCallable = z.custom<unknown>(value => value === undefined || typeof value === "function");
const responseTypeShape = versionRef.extend({
  config: z.array(id), validateQuestion: callable<unknown>(), parseValue: callable<unknown>(), isAnswered: callable<unknown>(),
  parseKey: optionalCallable, wholePaperKey: z.strictObject({ field: id, toKey: callable<unknown>() }).optional(),
});
const responseTypeRegistration = z.custom<RegisteredResponseType>(value => responseTypeShape.safeParse(value).success,
  "作答形态须经 defineResponseType 定义");
const toolRegistration = z.custom<ToolCapability>(value => typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "outputs")));
const runtimeOptions = z.strictObject({
  databasePath: z.string().min(1),
  tools: z.array(toolRegistration).default([]),
  responseTypes: z.array(responseTypeRegistration).default([]),
  evaluators: z.array(evaluatorRegistration).default([]),
  questionAnswerRules: z.array(answerRuleRegistration).default([]),
  authorizeChoiceDraftAmendment: z.custom<AuthorizeChoiceDraftAmendment>(value => typeof value === "function").optional(),
  authorizeChoiceSnapshotRevision: z.custom<AuthorizeChoiceSnapshotRevision>(value => typeof value === "function").optional(),
  hasChoiceSnapshotEvidence: z.custom<HasChoiceSnapshotEvidence>(value => typeof value === "function").optional(),
  verifyOriginal: z.custom<VerifyOriginal>(value => typeof value === "function").optional(),
  authorizeConfirmationRecovery: z.custom<AuthorizeConfirmationRecovery>(value => typeof value === "function").optional(),
  authorizeReview: z.custom<AuthorizeReview>(value => typeof value === "function").optional(),
  clock: callable<() => Date>().optional(),
  checkpoint: callable<RuntimeCheckpoint>().optional(),
});
const studentPrincipal = z.strictObject({ role: z.literal("student"), id });
const reviewerPrincipal = z.strictObject({ role: z.literal("reviewer"), id });
const publishedStartInput = startInput.extend({ practiceVersion: versionRef.shape.version });
const uuid = z.uuid();
const recoveryMode = z.literal("declared").optional();
const verdictMode = frozenConfirmationVerdictMode.optional();

export { LearningError };
export { verifyActivityBindings } from "./kernel/activity-bindings.ts";
export type { AuthorizeChoiceSnapshotRevision, ChoiceSnapshotRevisionInput, ChoiceSnapshotReviewerScope, HasChoiceSnapshotEvidence };
export type { AuthorizeChoiceDraftAmendment, ChoiceDraftAmendmentInput, ChoiceDraftAmendmentScope };
export type ReviewerPrincipal = z.input<typeof reviewerPrincipal>;
export type { ActivityBindingClaims, TeacherAmendmentBinding, TeacherAmendmentBindingClaims } from "./contracts/activity-bindings.ts";
export type { PreparedActivityVersionInput, PreparedActivityVersionReceipt };
export type { StudentValue, ToolCapability } from "./contracts/capabilities.ts";
export type { EvaluationContext, EvaluationInput, Evaluator, EvaluatorRegistration, QuestionAnswerRule, VerdictResult } from "./contracts/evaluator.ts";
export type { QuestionDefinition, QuestionIssue, RegisteredResponseType, ResponseType } from "./contracts/response-type.ts";
export { defineResponseType } from "./contracts/response-type.ts";
export { defaultEvaluators, defaultResponseTypes, defaultTools } from "./extensions/index.ts";
export type { QuestionDeliveryDraftInput, QuestionDeliveryInput };
export type { AuthorizeReview, ReviewAccess, ReviewedDelivery, ReviewScope, VerdictCommand, VerdictReceipt } from "./contracts/verdict.ts";
export { QuestionDeliveryConflict } from "./kernel/question-delivery-drafts.ts";
export { ChoiceConfirmationConflict } from "./kernel/choice-confirmation.ts";
export type { ChoiceDraftActivity } from "./kernel/choice-draft-activity.ts";
export { ChoiceSnapshotRevisionConflict } from "./kernel/choice-snapshot.ts";
export { ChoiceDraftConflict } from "./kernel/choice-drafts.ts";
export { ResponseConfirmationConflict } from "./kernel/response-confirmation.ts";
export { ResponseDraftConflict } from "./kernel/response-drafts.ts";
export type { EvaluationSummary } from "./kernel/pending-evaluation.ts";
export type { RuntimeCheckpoint } from "./kernel/runtime-checkpoint.ts";
export type { ResponseConfirmation, ResponseConfirmationInput, ResponseDraftInput, ResponseValue } from "./contracts/response.ts";
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

type DeclaredQuestionDeliveryRecovery = ReturnType<typeof recoverQuestionDelivery>;
type AutomaticQuestionDeliveryRecovery = Omit<Extract<DeclaredQuestionDeliveryRecovery, { assessment: "automatic" }>, "assessment">;

export function openLearningRuntime(options: z.input<typeof runtimeOptions>) {
  const settings = runtimeOptions.parse(options);
  const registry = createRegistry({
    tools: [...defaultTools, ...settings.tools],
    responseTypes: [...defaultResponseTypes, ...settings.responseTypes],
    evaluators: [...defaultEvaluators, ...settings.evaluators],
    answerRules: settings.questionAnswerRules,
  });
  const database = openDatabase(settings.databasePath);
  const clock = settings.clock ?? (() => new Date());

  function recoverDelivery(principal: StudentPrincipal, activityId: string, key: ConfirmationKey, mode: "declared"): DeclaredQuestionDeliveryRecovery;
  function recoverDelivery(principal: StudentPrincipal, activityId: string, key: ConfirmationKey): AutomaticQuestionDeliveryRecovery;
  function recoverDelivery(principal: StudentPrincipal, activityId: string, key: ConfirmationKey, input?: "declared") {
    const mode = recoveryMode.parse(input);
    const recovered = recoverQuestionDelivery(database, principalId(studentPrincipal, principal), uuid.parse(activityId),
      confirmationKey.parse(key), settings.authorizeConfirmationRecovery, mode ?? "automatic");
    if (mode === "declared" || recovered.assessment !== "automatic") return recovered;
    const { assessment: _assessment, ...legacy } = recovered;
    return legacy;
  }

  function readDeliveryReview(principal: ReviewerPrincipal, activityId: string, key: ConfirmationKey, mode: "verdicts"): ReturnType<typeof readQuestionDeliveryVerdicts>;
  function readDeliveryReview(principal: ReviewerPrincipal, activityId: string, key: ConfirmationKey, mode: "choiceConfirmation"): ReturnType<typeof readChoiceConfirmationVerdicts>;
  function readDeliveryReview(principal: ReviewerPrincipal, activityId: string, key: ConfirmationKey, mode: "responseConfirmation"): ReturnType<typeof readResponseConfirmationVerdicts>;
  function readDeliveryReview(principal: ReviewerPrincipal, activityId: string, key: ConfirmationKey): ReturnType<typeof readQuestionDeliveryReview>;
  function readDeliveryReview(principal: ReviewerPrincipal, activityId: string, key: ConfirmationKey, input?: "verdicts" | FrozenConfirmationVerdictMode) {
    const mode = questionDeliveryReviewMode.parse(input);
    const reviewerId = principalId(reviewerPrincipal, principal);
    const activity = uuid.parse(activityId);
    const confirmation = confirmationKey.parse(key);
    if (mode === "choiceConfirmation") return readChoiceConfirmationVerdicts(database, reviewerId, activity, confirmation, settings.authorizeReview);
    if (mode === "responseConfirmation") return readResponseConfirmationVerdicts(database, reviewerId, activity, confirmation, settings.authorizeReview);
    const read = mode === "verdicts" ? readQuestionDeliveryVerdicts : readQuestionDeliveryReview;
    return read(database, reviewerId, activity, confirmation, settings.authorizeReview);
  }

  return {
    ...readingEntries({ database, registry, clock, checkpoint: settings.checkpoint }),
    publish(input: PublicationInput) {
      registerPublication(database, input, registry);
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
      return saveChoiceDraft(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceDraftInput.parse(input), clock);
    },
    saveCurrentChoiceDraft(
      principal: StudentPrincipal, activityId: string, input: ChoiceDraftInput | UnversionedChoiceDraftInput, mode: CurrentChoiceDraftMode = "save",
    ) {
      return saveCurrentChoiceDraft(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceDraftInput.parse(input),
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
      return confirmChoices(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId), choiceConfirmationInput.parse(input),
        clock, settings.verifyOriginal);
    },
    recoverChoiceConfirmation(principal: StudentPrincipal, activityId: string, key: ConfirmationKey) {
      return recoverChoiceConfirmation(database, principalId(studentPrincipal, principal), uuid.parse(activityId),
        confirmationKey.parse(key), settings.authorizeConfirmationRecovery);
    },
    saveResponseDraft(
      principal: StudentPrincipal, activityId: string, input: ResponseDraftInput, mode: CurrentChoiceDraftMode = "save",
    ) {
      return saveResponseDraft(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId),
        responseDraftInput.parse(input), currentChoiceDraftMode.parse(mode), clock);
    },
    confirmResponses(principal: StudentPrincipal, activityId: string, input: ResponseConfirmationInput) {
      return confirmResponses(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId),
        choiceConfirmationInput.parse(input), clock, settings.verifyOriginal);
    },
    recoverResponseConfirmation(principal: StudentPrincipal, activityId: string, key: ConfirmationKey) {
      return recoverResponseConfirmation(database, principalId(studentPrincipal, principal), uuid.parse(activityId),
        confirmationKey.parse(key), settings.authorizeConfirmationRecovery);
    },
    saveQuestionDeliveryDraft(
      principal: StudentPrincipal, activityId: string, input: QuestionDeliveryDraftInput, mode: CurrentChoiceDraftMode = "save",
    ) {
      return saveQuestionDeliveryDraft(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId),
        questionDeliveryDraftInput.parse(input), currentChoiceDraftMode.parse(mode), clock);
    },
    confirmQuestionDelivery(principal: StudentPrincipal, activityId: string, input: QuestionDeliveryInput) {
      return confirmQuestionDelivery(database, registry, principalId(studentPrincipal, principal), uuid.parse(activityId),
        questionDeliveryInput.parse(input), clock, settings.verifyOriginal, settings.authorizeConfirmationRecovery);
    },
    recoverQuestionDelivery: recoverDelivery,
    readQuestionDeliveryReview: readDeliveryReview,
    writeQuestionDeliveryVerdict(principal: ReviewerPrincipal, activityId: string, key: ConfirmationKey, command: VerdictCommand, input?: FrozenConfirmationVerdictMode) {
      return writeQuestionDeliveryVerdict(database, principalId(reviewerPrincipal, principal), uuid.parse(activityId),
        confirmationKey.parse(key), verdictCommand.parse(command), settings.authorizeReview, clock, verdictMode.parse(input));
    },
    evaluatePending(scope?: { submissionId: string }): EvaluationSummary {
      return evaluatePending(database, registry, settings.checkpoint, scope && uuid.parse(scope.submissionId));
    },
    close() {
      database.close();
    },
  };
}
