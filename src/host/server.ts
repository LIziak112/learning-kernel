import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { startInput, redoInput, saveInput, submitInput } from "../contracts/reading.ts";
import type { SubmitInput } from "../contracts/reading.ts";
import { readingAnswerInput, readingSaveInput } from "../contracts/reading-runtime.ts";
import { verdictCommand } from "../contracts/verdict.ts";
import { redoActivity, startActivity } from "../kernel/activity.ts";
import { openDatabase } from "../kernel/database.ts";
import { evaluatePending } from "../kernel/evaluation.ts";
import { LearningError } from "../kernel/learning-error.ts";
import { registerPublication } from "../kernel/publication.ts";
import { managementInput, manageReading } from "../kernel/review-access.ts";
import { readReview, selectionFeedbackInput, writeSelectionFeedback, writeVerdict } from "../kernel/review.ts";
import type { RuntimeCheckpoint } from "../kernel/runtime-checkpoint.ts";
import { readActivity, readStudentFragment, readStudentResults, readSubmission, saveDraft, submitDraft } from "../kernel/submission.ts";
import { readPersonalDraft } from "../kernel/work-versions.ts";
import { authenticate, readJSON, sendJSON, sendError } from "./http.ts";

type PageHandler = (request: IncomingMessage, response: ServerResponse, path: string) => boolean;
type Identity = { id: string; role: "student" | "reviewer" };
type HostOptions = {
  databasePath: string;
  publication: unknown;
  sessions: ReadonlyMap<string, string>;
  reviewerSessions?: ReadonlyMap<string, string>;
  assignedReviewer?: string | undefined;
  additionalPublications?: readonly unknown[];
  servePage?: PageHandler;
  evaluateAutomatically?: boolean;
  clock?: () => Date;
  beforeConfirmation?: (input: SubmitInput) => Promise<void>;
  checkpoint?: RuntimeCheckpoint;
  beforeDelivery?: (path: string) => Promise<void>;
};
type HostContext = {
  database: DatabaseSync;
  lookup: (token: string) => Identity | undefined;
  scheduleEvaluation: () => void;
  clock: () => Date;
  beforeConfirmation: HostOptions["beforeConfirmation"];
  checkpoint: RuntimeCheckpoint | undefined;
  beforeDelivery: HostOptions["beforeDelivery"];
  assignedReviewer?: string | undefined;
  servePage?: PageHandler | undefined;
};
const saveRequest = z.union([saveInput, readingSaveInput, readingAnswerInput]);

function openHostDatabase(options: HostOptions) {
  const database = openDatabase(options.databasePath);
  try {
    registerPublication(database, options.publication);
    options.additionalPublications?.forEach(publication => registerPublication(database, publication));
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

function evaluationSchedule(database: DatabaseSync, enabled = true, checkpoint?: RuntimeCheckpoint) {
  let scheduled: NodeJS.Immediate | undefined;
  return {
    schedule() {
      if (!enabled || scheduled) return;
      scheduled = setImmediate(() => {
        scheduled = undefined;
        try {
          evaluatePending(database, checkpoint);
        } catch (error) {
          console.error(error);
        }
      });
    },
    cancel() {
      if (scheduled) clearImmediate(scheduled);
    },
  };
}

function sessionLookup(options: HostOptions, token: string): Identity | undefined {
  const student = options.sessions.get(token);
  if (student) return { id: student, role: "student" };
  const reviewer = options.reviewerSessions?.get(token);
  return reviewer ? { id: reviewer, role: "reviewer" } : undefined;
}

export function createLearningServer(options: HostOptions) {
  const database = openHostDatabase(options);
  const evaluation = evaluationSchedule(database, options.evaluateAutomatically, options.checkpoint);
  const context: HostContext = {
    database, lookup: token => sessionLookup(options, token), scheduleEvaluation: evaluation.schedule,
    clock: options.clock ?? (() => new Date()), beforeConfirmation: options.beforeConfirmation,
    checkpoint: options.checkpoint, beforeDelivery: options.beforeDelivery,
    assignedReviewer: options.assignedReviewer, servePage: options.servePage,
  };
  const server = createServer((request, response) => {
    serve(request, response, context).catch(error => sendError(response, error));
  });
  server.once("listening", evaluation.schedule);
  server.once("close", () => {
    evaluation.cancel();
    database.close();
  });
  return server;
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  context: HostContext,
) {
  const { pathname: path, search } = new URL(z.string().parse(request.url), "http://localhost");
  if (context.servePage?.(request, response, path)) return;
  const identity = authenticate(request, context.lookup);
  if (request.method === "GET") await authorizeDelivery(request, context, identity, path, search);
  const staff = path.match(/^\/api\/(reviews|manage)\/([a-f0-9-]{36})(?:\/(verdicts|history|export|submissions|fragments)(?:\/([a-f0-9-]{36}))?)?$/);
  const data = staff
    ? await staffRequest(request, context, identity, staff)
    : await studentRequest(request, context, identity, path);
  return sendJSON(response, 200, data);
}

async function authorizeDelivery(
  request: IncomingMessage, context: HostContext, identity: Identity, path: string, search: string,
) {
  if (search) throw new LearningError(403, "FORBIDDEN");
  await context.beforeDelivery?.(path);
  requireSameIdentity(request, context, identity);
}

async function staffRequest(request: IncomingMessage, context: HostContext, identity: Identity, route: RegExpMatchArray) {
  if (identity.role !== "reviewer") throw new LearningError(403, "FORBIDDEN");
  const [, group, identifier, resource, item] = route;
  const activityId = z.uuid().parse(identifier);
  if (group === "reviews") return reviewRequest(request, context, identity, activityId, resource, item);
  if (request.method !== "POST" || resource) throw new LearningError(404, "NOT_FOUND");
  const command = managementInput.parse(await readJSON(request));
  requireSameIdentity(request, context, identity);
  return manageReading(context.database, identity.id, activityId, command.action);
}

async function studentRequest(
  request: IncomingMessage,
  context: HostContext,
  identity: Identity,
  path: string,
) {
  if (identity.role !== "student") throw new LearningError(403, "FORBIDDEN");
  const student = identity.id;
  if (request.method === "POST" && path === "/api/activities") {
    const input = startInput.parse(await readJSON(request));
    requireSameIdentity(request, context, identity);
    return startActivity(context.database, student, input, context.clock, context.assignedReviewer);
  }
  const personal = path.match(/^\/api\/drafts\/([a-f0-9-]{36})$/);
  if (request.method === "GET" && personal) return readPersonalDraft(context.database, student, z.uuid().parse(personal[1]));
  const match = path.match(
    /^\/api\/activities\/([a-f0-9-]{36})(?:\/(drafts|submissions|assessment|review|export|fragments|redo)(?:\/([^/]+))?)?$/,
  );
  if (!match) throw new LearningError(404, "NOT_FOUND");
  const [, identifier, resource, submissionId] = match;
  const activityId = z.uuid().parse(identifier);
  return request.method === "GET"
    ? get(context.database, student, activityId, resource, submissionId)
    : await post(request, context, student, activityId, resource, submissionId);
}

async function reviewRequest(
  request: IncomingMessage, context: HostContext, identity: Identity, activityId: string, resource?: string, item?: string,
) {
  if (request.method === "GET") return reviewerGet(context.database, identity.id, activityId, resource, item);
  if (request.method === "POST" && !item) {
    const command = await readJSON(request);
    requireSameIdentity(request, context, identity);
    if (resource === "verdicts") {
      return writeVerdict(context.database, identity.id, activityId, verdictCommand.parse(command), context.clock);
    }
    if (!resource) return writeSelectionFeedback(context.database, identity.id, activityId, selectionFeedbackInput.parse(command).text);
  }
  throw new LearningError(404, "NOT_FOUND");
}

function reviewerGet(database: DatabaseSync, reviewer: string, activityId: string, resource?: string, item?: string) {
  const view = readReview(database, reviewer, activityId);
  if (resource === "submissions" || resource === "fragments") {
    return reviewerItem(view.submissions, resource, item);
  }
  if (item) throw new LearningError(404, "NOT_FOUND");
  if (!resource || resource === "export") return view;
  if (resource === "history") return { verdicts: view.verdicts, automaticVerdicts: view.automaticVerdicts };
  throw new LearningError(404, "NOT_FOUND");
}

function reviewerItem(
  submissions: ReturnType<typeof readReview>["submissions"], resource: "submissions" | "fragments", item?: string,
) {
  if (!item) throw new LearningError(404, "NOT_FOUND");
  const submitted = submissions.find(record => record.receipt.id === item);
  if (!submitted) throw new LearningError(403, "FORBIDDEN");
  if (resource === "submissions") return submitted;
  if (submitted.selection) return submitted.selection;
  throw new LearningError(403, "FORBIDDEN");
}

function get(database: DatabaseSync, student: string, activityId: string, resource?: string, submissionId?: string) {
  if (!resource) return readActivity(database, student, activityId);
  if (resource === "assessment" || resource === "review" || resource === "export") {
    if (submissionId) throw new LearningError(403, "FORBIDDEN");
    return readStudentResults(database, student, activityId, resource);
  }
  if (!submissionId) throw new LearningError(404, "NOT_FOUND");
  if (resource === "submissions") return readSubmission(database, student, activityId, z.uuid().parse(submissionId));
  if (resource === "fragments") return readStudentFragment(database, student, activityId, z.uuid().parse(submissionId));
  throw new LearningError(404, "NOT_FOUND");
}

async function post(
  request: IncomingMessage,
  context: HostContext,
  student: string,
  activityId: string,
  resource?: string,
  submissionId?: string,
) {
  if (request.method !== "POST" || submissionId) throw new LearningError(404, "NOT_FOUND");
  if (resource === "drafts") {
    const input = saveRequest.parse(await readJSON(request));
    requireSameIdentity(request, context, { id: student, role: "student" });
    return saveDraft(context.database, student, activityId, input);
  }
  if (resource === "submissions") {
    const input = submitInput.parse(await readJSON(request));
    return confirmRequest(request, context, student, activityId, input);
  }
  if (resource === "redo") {
    const input = redoInput.parse(await readJSON(request));
    requireSameIdentity(request, context, { id: student, role: "student" });
    return redoActivity(context.database, student, activityId, input.operationId, context.clock);
  }
  throw new LearningError(404, "NOT_FOUND");
}

async function confirmRequest(request: IncomingMessage, context: HostContext, student: string, activityId: string, input: SubmitInput) {
  await context.beforeConfirmation?.(input);
  requireSameIdentity(request, context, { id: student, role: "student" });
  const receipt = submitDraft(context.database, student, activityId, input, context.clock, context.checkpoint);
  context.checkpoint?.({ point: "afterConfirmationCommit", operationId: input.operationId });
  context.scheduleEvaluation();
  return receipt;
}

function requireSameIdentity(request: IncomingMessage, context: HostContext, expected: Identity) {
  const actor = authenticate(request, context.lookup);
  if (actor.role !== expected.role || actor.id !== expected.id) throw new LearningError(403, "FORBIDDEN");
}
