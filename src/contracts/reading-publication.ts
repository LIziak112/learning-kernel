import { z } from "zod";
import { id, materialSchema, versionRef } from "./reading.ts";

const nonempty = z.string().min(1);
const descriptions = z.record(id, nonempty).refine(value => Object.keys(value).length > 0);
const slotReference = z.strictObject({ stepId: id, slotId: id });
const input = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("material"), positionId: id }),
  z.strictObject({ from: z.literal("questions") }),
  slotReference.extend({ from: z.literal("submission"), readOnly: z.literal(true) }),
]);
const newEvidence = z.strictObject({ source: id, targetId: id });
const slot = z.discriminatedUnion("type", [
  newEvidence.extend({
    type: z.literal("passageSelection"),
    oneRangePerRole: descriptions,
    distinctParagraphs: z.boolean(),
    evidenceUnit: z.literal("wholeSelection"),
  }),
  newEvidence.extend({ type: z.literal("oneChoicePerQuestion"), reasonTargetId: id.optional() }),
  z.strictObject({ type: z.literal("reuse"), source: id }),
]);

const step = z.strictObject({
  id,
  requires: id.optional(),
  instructions: nonempty,
  tool: versionRef,
  inputs: z.record(id, input),
  submit: z.strictObject({
    purpose: z.enum(["stepEvidence", "finalAnswer"]),
    slots: z.record(id, slot),
  }),
  afterConfirmation: z.enum(["advance", "finish"]),
});

const policy = z.strictObject({
  timeLimit: z.strictObject({
    minutes: z.int().positive(),
    startsAt: z.literal("instanceStarted"),
    onDeadline: z.literal("keepDraftAndClose"),
  }),
  offline: z.literal("onlineOnly"),
  redo: z.literal("newInstanceOnAuthorization"),
  student: z.strictObject({
    ownSubmission: z.strictObject({
      scope: z.literal("ownConfirmedSubmissions"),
      fields: z.array(z.enum(["receipt", "submittedQuotes", "ownChoices"])),
      onFinal: z.array(z.literal("passageGradingStatus")),
    }),
    passageScore: z.strictObject({
      whenAll: z.tuple([z.literal("finalConfirmed"), z.literal("allQuestionsJudged")]),
      group: z.literal("wholePassage"),
      fields: z.array(z.enum(["correctCount", "questionCount"])),
      allowSubsets: z.literal(false),
      drilldown: z.literal(false),
    }),
    review: z.strictObject({
      requires: z.literal("passageScore"),
      while: z.literal("reviewOpen"),
      byQuestion: z.array(z.literal("effectiveVerdict")),
      byQuoteSet: z.array(z.literal("learnerFeedback")),
    }),
  }),
  reviewer: z.strictObject({
    scope: z.literal("assignedReviewer"),
    fields: z.array(z.enum(["submittedQuotes", "studentChoices", "learnerFeedback", "verdictHistory", "gradingBasis"])),
    actions: z.array(z.enum(["commentOnQuotes", "reviseQuestionVerdict"])),
  }),
  manager: z.strictObject({
    scope: z.literal("assigningTeacher"),
    actions: z.array(z.enum(["openReview", "closeReview", "authorizeRedo"])),
  }),
  externalAi: z.literal("disabled"),
});

export const readingPracticeSchema = versionRef.extend({
  formatVersion: z.literal(1),
  title: nonempty,
  material: versionRef,
  goals: descriptions,
  questions: z.array(z.strictObject({
    id, prompt: nonempty, options: descriptions,
  })).min(1),
  steps: z.tuple([step]).rest(step),
  grading: z.strictObject({
    selectionFeedback: z.strictObject({ from: slotReference, criterion: nonempty }).optional(),
    assessment: z.strictObject({
      from: slotReference,
      evaluator: versionRef,
      keyRef: versionRef,
      unit: z.literal("question"),
      effectiveVerdictOrder: z.tuple([z.literal("teacherReview"), z.literal("automatic")]),
    }),
  }),
  policy,
});

export const scoringKeySchema = versionRef.extend({
  acceptedChoices: z.record(id, id).transform(choices =>
    Object.fromEntries(Object.keys(choices).sort().map(question => [question, choices[question]]))),
});

export const readingPublicationSchema = z.strictObject({
  material: materialSchema,
  practice: readingPracticeSchema,
  scoringKey: scoringKeySchema,
});

export type ReadingPublication = z.infer<typeof readingPublicationSchema>;
export type ReadingStep = z.infer<typeof step>;
export type ReadingSlot = z.infer<typeof slot>;
