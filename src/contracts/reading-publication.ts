import { z } from "zod";
import { orderedQuestionValues, questionDeliveryMode, questionDeliveryReviewBasis, questionDeliveryScoringKey } from "./question-delivery.ts";
import { id, materialSchema, versionRef } from "./reading.ts";

const nonempty = z.string().min(1);
const descriptions = z.record(id, nonempty).refine(value => Object.keys(value).length > 0);
const slotReference = z.strictObject({ stepId: id, slotId: id });
const input = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("material"), positionId: id, material: versionRef.optional() }),
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
  newEvidence.extend({
    type: z.literal("oneChoicePerQuestion"), reasonTargetId: id.optional(),
    confirmFromDrafts: z.strictObject({ allowUnanswered: z.boolean() }).optional(),
  }),
  newEvidence.extend({
    type: z.literal("oneResponsePerQuestion"), input: id,
    confirmFromDrafts: z.strictObject({ allowUnanswered: z.boolean() }),
  }),
  newEvidence.extend({
    type: z.literal("questionDelivery"),
    delivery: questionDeliveryMode,
    confirmFromDrafts: z.strictObject({ allowUnanswered: z.boolean() }),
  }),
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
  }).optional(),
  offline: z.literal("onlineOnly"),
  redo: z.literal("newInstanceOnAuthorization"),
  student: z.strictObject({
    ownSubmission: z.strictObject({
      scope: z.literal("ownConfirmedSubmissions"),
      fields: z.array(z.enum(["receipt", "submittedQuotes", "ownChoices", "ownResponses"])),
      onFinal: z.array(z.literal("passageGradingStatus")),
    }),
    restart: z.literal("anytime").optional(),
    passageScore: z.strictObject({
      whenAll: z.tuple([z.literal("finalConfirmed"), z.literal("allQuestionsJudged")]),
      group: z.literal("wholePassage"),
      fields: z.array(z.enum(["correctCount", "questionCount"])),
      allowSubsets: z.literal(false),
      drilldown: z.literal(false),
    }).optional(),
    review: z.strictObject({
      requires: z.literal("passageScore"),
      while: z.literal("reviewOpen"),
      byQuestion: z.array(z.literal("effectiveVerdict")),
      byQuoteSet: z.array(z.literal("learnerFeedback")),
    }).optional(),
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

export const questionFields = ["id", "version", "prompt", "options", "response"] as const;
export const readingQuestion = z.looseObject({
  id, version: versionRef.shape.version.optional(), prompt: nonempty, options: z.record(id, nonempty).default({}),
  response: id.optional(),
});

export const readingPracticeSchema = versionRef.extend({
  formatVersion: z.literal(1),
  title: nonempty,
  material: versionRef.optional(),
  goals: descriptions,
  questions: z.array(readingQuestion).default([]),
  questionAnswerRules: z.record(id, versionRef).transform(orderedQuestionValues).optional(),
  steps: z.tuple([step]).rest(step),
  grading: z.strictObject({
    selectionFeedback: z.strictObject({ from: slotReference, criterion: nonempty }).optional(),
    assessment: z.strictObject({
      from: slotReference,
      evaluator: versionRef,
      keyRef: versionRef,
      unit: z.literal("question"),
      effectiveVerdictOrder: z.tuple([z.literal("teacherReview"), z.literal("automatic")]),
    }).optional(),
    manualReview: z.strictObject({ keyRef: versionRef }).optional(),
    teacherReview: z.strictObject({
      questionIds: z.array(id).min(1).refine(ids => new Set(ids).size === ids.length, "评阅题标识重复")
        .transform(ids => ids.toSorted()),
    }).optional(),
  }).default({}),
  policy,
});

const keyedValues = z.record(id, z.json());
const keyIdentity = new Set(["id", "version"]);
export const wholePaperScoringKey = z.looseObject(versionRef.shape)
  .refine(key => Object.entries(key).every(([field, value]) => keyIdentity.has(field) || keyedValues.safeParse(value).success),
    "整卷评分键的字段须按题编号")
  .transform(({ id: keyId, version, ...fields }) => ({
    id: keyId, version,
    ...Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, orderedQuestionValues(keyedValues.parse(value))])),
  }));

export const readingPublicationSchema = z.strictObject({
  material: materialSchema.optional(),
  materials: z.array(materialSchema).min(1).optional(),
  practice: readingPracticeSchema,
  scoringKey: z.union([questionDeliveryScoringKey, questionDeliveryReviewBasis, wholePaperScoringKey]).optional(),
});

export type ReadingPublication = z.infer<typeof readingPublicationSchema>;
export type ReadingStep = z.infer<typeof step>;
export type ReadingSlot = z.infer<typeof slot>;
