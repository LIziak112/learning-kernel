import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { LearningError } from "../contracts/learning-error.ts";
import { id, redoInput, saveInput, startInput, submitInput } from "../contracts/reading.ts";
import { readingAnswerInput, readingSaveInput } from "../contracts/reading-runtime.ts";
import { verdictCommand } from "../contracts/verdict.ts";
import { redoActivity, startActivity } from "../kernel/activity.ts";
import type { Registry } from "../kernel/registry.ts";
import { managementInput, managementView, manageReading } from "../kernel/review-access.ts";
import { readReview, selectionFeedbackInput, writeSelectionFeedback, writeVerdict } from "../kernel/review.ts";
import type { RuntimeCheckpoint } from "../kernel/runtime-checkpoint.ts";
import { readStudentFragment, readStudentResults, readSubmission, saveDraft, submitDraft } from "../kernel/submission.ts";
import { readPersonalDraft } from "../kernel/work-versions.ts";

const student = z.strictObject({ role: z.literal("student"), id });
const reviewer = z.strictObject({ role: z.literal("reviewer"), id });
const uuid = z.uuid();
const saveRequest = z.union([saveInput, readingSaveInput, readingAnswerInput]);
const studentResource = z.enum(["assessment", "review", "export"]);
const assignment = z.strictObject({ assignedReviewer: id.optional() }).optional();

type Context = { database: DatabaseSync; registry: Registry; clock: () => Date; checkpoint: RuntimeCheckpoint | undefined };
type Principal = { role: string; id: string };

function principalOf(schema: typeof student | typeof reviewer, principal: Principal) {
  const parsed = schema.safeParse(principal);
  if (!parsed.success) throw new LearningError(403, "FORBIDDEN");
  return parsed.data.id;
}

export function readingEntries({ database, registry, clock, checkpoint }: Context) {
  const learner = (principal: Principal) => principalOf(student, principal);
  const teacher = (principal: Principal) => principalOf(reviewer, principal);
  return {
    startLatest(principal: Principal, input: unknown, options?: { assignedReviewer?: string }) {
      return startActivity(database, learner(principal), startInput.parse(input), clock, assignment.parse(options)?.assignedReviewer);
    },
    redo(principal: Principal, activityId: string, input: unknown) {
      return redoActivity(database, learner(principal), uuid.parse(activityId), redoInput.parse(input).operationId, clock);
    },
    saveDraft(principal: Principal, activityId: string, input: unknown) {
      return saveDraft(database, registry, learner(principal), uuid.parse(activityId), saveRequest.parse(input));
    },
    submitDraft(principal: Principal, activityId: string, input: unknown) {
      return submitDraft(database, registry, learner(principal), uuid.parse(activityId), submitInput.parse(input), clock, checkpoint);
    },
    readSubmission(principal: Principal, activityId: string, submissionId: string) {
      return readSubmission(database, learner(principal), uuid.parse(activityId), uuid.parse(submissionId));
    },
    readFragment(principal: Principal, activityId: string, submissionId: string) {
      return readStudentFragment(database, learner(principal), uuid.parse(activityId), uuid.parse(submissionId));
    },
    readResults(principal: Principal, activityId: string, resource: "assessment" | "review" | "export") {
      return readStudentResults(database, learner(principal), uuid.parse(activityId), studentResource.parse(resource));
    },
    readPersonalDraft(principal: Principal, workId: string) {
      return readPersonalDraft(database, learner(principal), uuid.parse(workId));
    },
    readReadingReview(principal: Principal, activityId: string) {
      return readReview(database, teacher(principal), uuid.parse(activityId));
    },
    writeReadingVerdict(principal: Principal, activityId: string, command: unknown) {
      return writeVerdict(database, teacher(principal), uuid.parse(activityId), verdictCommand.parse(command), clock);
    },
    writeSelectionFeedback(principal: Principal, activityId: string, input: unknown) {
      return writeSelectionFeedback(database, teacher(principal), uuid.parse(activityId), selectionFeedbackInput.parse(input).text);
    },
    readManagement(principal: Principal, activityId: string) {
      return managementView(database, teacher(principal), uuid.parse(activityId));
    },
    manage(principal: Principal, activityId: string, input: unknown) {
      return manageReading(database, teacher(principal), uuid.parse(activityId), managementInput.parse(input).action);
    },
  };
}
