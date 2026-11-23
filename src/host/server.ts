import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { LearningError } from "../contracts/learning-error.ts";
import { submitInput } from "../contracts/reading.ts";
import type { SubmitInput } from "../contracts/reading.ts";
import { openLearningRuntime } from "../server.ts";
import type { PublicationInput, RuntimeCheckpoint } from "../server.ts";
import { authenticate, readJSON, sendJSON, sendError } from "./http.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;
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
  runtime: Runtime;
  lookup: (token: string) => Identity | undefined;
  scheduleEvaluation: () => void;
  beforeConfirmation: HostOptions["beforeConfirmation"];
  checkpoint: RuntimeCheckpoint | undefined;
  beforeDelivery: HostOptions["beforeDelivery"];
  assignedReviewer?: string | undefined;
  servePage?: PageHandler | undefined;
};

function openHostRuntime(options: HostOptions) {
  const runtime = openLearningRuntime({
    databasePath: options.databasePath,
    ...options.clock && { clock: options.clock },
    ...options.checkpoint && { checkpoint: options.checkpoint },
  });
  try {
    for (const publication of [options.publication, ...options.additionalPublications ?? []]) {
      runtime.publish(z.custom<PublicationInput>(value => typeof value === "object" && value !== null).parse(publication));
    }
  } catch (error) {
    runtime.close();
    throw error;
  }
  return runtime;
}

function evaluationSchedule(runtime: Runtime, enabled = true) {
  let scheduled: NodeJS.Immediate | undefined;
  return {
    schedule() {
      if (!enabled || scheduled) return;
      scheduled = setImmediate(() => {
        scheduled = undefined;
        try {
          runtime.evaluatePending();
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
  const runtime = openHostRuntime(options);
  const evaluation = evaluationSchedule(runtime, options.evaluateAutomatically);
  const context: HostContext = {
    runtime, lookup: token => sessionLookup(options, token), scheduleEvaluation: evaluation.schedule,
    beforeConfirmation: options.beforeConfirmation, checkpoint: options.checkpoint, beforeDelivery: options.beforeDelivery,
    assignedReviewer: options.assignedReviewer, servePage: options.servePage,
  };
  const server = createServer((request, response) => {
    serve(request, response, context).catch(error => sendError(response, error));
  });
  server.once("listening", evaluation.schedule);
  server.once("close", () => {
    evaluation.cancel();
    runtime.close();
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
  if (resource) throw new LearningError(404, "NOT_FOUND");
  if (request.method === "GET") return context.runtime.readManagement(identity, activityId);
  if (request.method !== "POST") throw new LearningError(404, "NOT_FOUND");
  const command = await readJSON(request);
  requireSameIdentity(request, context, identity);
  return context.runtime.manage(identity, activityId, command);
}

async function studentRequest(
  request: IncomingMessage,
  context: HostContext,
  identity: Identity,
  path: string,
) {
  if (identity.role !== "student") throw new LearningError(403, "FORBIDDEN");
  if (request.method === "POST" && path === "/api/activities") {
    const input = await readJSON(request);
    requireSameIdentity(request, context, identity);
    return context.runtime.startLatest(identity, input, context.assignedReviewer ? { assignedReviewer: context.assignedReviewer } : undefined);
  }
  const personal = path.match(/^\/api\/drafts\/([a-f0-9-]{36})$/);
  if (request.method === "GET" && personal) return context.runtime.readPersonalDraft(identity, z.uuid().parse(personal[1]));
  const match = path.match(
    /^\/api\/activities\/([a-f0-9-]{36})(?:\/(drafts|submissions|assessment|review|export|fragments|redo)(?:\/([^/]+))?)?$/,
  );
  if (!match) throw new LearningError(404, "NOT_FOUND");
  const [, identifier, resource, submissionId] = match;
  const activityId = z.uuid().parse(identifier);
  return request.method === "GET"
    ? get(context.runtime, identity, activityId, resource, submissionId)
    : await post(request, context, identity, activityId, resource, submissionId);
}

async function reviewRequest(
  request: IncomingMessage, context: HostContext, identity: Identity, activityId: string, resource?: string, item?: string,
) {
  if (request.method === "GET") return reviewerGet(context.runtime, identity, activityId, resource, item);
  if (request.method === "POST" && !item) {
    const command = await readJSON(request);
    requireSameIdentity(request, context, identity);
    if (resource === "verdicts") return context.runtime.writeReadingVerdict(identity, activityId, command);
    if (!resource) return context.runtime.writeSelectionFeedback(identity, activityId, command);
  }
  throw new LearningError(404, "NOT_FOUND");
}

function reviewerGet(runtime: Runtime, reviewer: Identity, activityId: string, resource?: string, item?: string) {
  const view = runtime.readReadingReview(reviewer, activityId);
  if (resource === "submissions" || resource === "fragments") {
    return reviewerItem(view.submissions, resource, item);
  }
  if (item) throw new LearningError(404, "NOT_FOUND");
  if (!resource || resource === "export") return view;
  if (resource === "history") return { verdicts: view.verdicts, automaticVerdicts: view.automaticVerdicts };
  throw new LearningError(404, "NOT_FOUND");
}

function reviewerItem(
  submissions: ReturnType<Runtime["readReadingReview"]>["submissions"], resource: "submissions" | "fragments", item?: string,
) {
  if (!item) throw new LearningError(404, "NOT_FOUND");
  const submitted = submissions.find(record => record.receipt.id === item);
  if (!submitted) throw new LearningError(403, "FORBIDDEN");
  if (resource === "submissions") return submitted;
  if (submitted.selection) return submitted.selection;
  throw new LearningError(403, "FORBIDDEN");
}

function get(runtime: Runtime, student: Identity, activityId: string, resource?: string, submissionId?: string) {
  if (!resource) return runtime.read(identityOf(student), activityId);
  if (resource === "assessment" || resource === "review" || resource === "export") {
    if (submissionId) throw new LearningError(403, "FORBIDDEN");
    return runtime.readResults(student, activityId, resource);
  }
  if (!submissionId) throw new LearningError(404, "NOT_FOUND");
  if (resource === "submissions") return runtime.readSubmission(student, activityId, submissionId);
  if (resource === "fragments") return runtime.readFragment(student, activityId, submissionId);
  throw new LearningError(404, "NOT_FOUND");
}

async function post(
  request: IncomingMessage,
  context: HostContext,
  student: Identity,
  activityId: string,
  resource?: string,
  submissionId?: string,
) {
  if (request.method !== "POST" || submissionId) throw new LearningError(404, "NOT_FOUND");
  if (resource === "drafts") {
    const input = await readJSON(request);
    requireSameIdentity(request, context, student);
    return context.runtime.saveDraft(student, activityId, input);
  }
  if (resource === "submissions") {
    const input = submitInput.parse(await readJSON(request));
    return confirmRequest(request, context, student, activityId, input);
  }
  if (resource === "redo") {
    const input = await readJSON(request);
    requireSameIdentity(request, context, student);
    return context.runtime.redo(student, activityId, input);
  }
  throw new LearningError(404, "NOT_FOUND");
}

async function confirmRequest(request: IncomingMessage, context: HostContext, student: Identity, activityId: string, input: SubmitInput) {
  await context.beforeConfirmation?.(input);
  requireSameIdentity(request, context, student);
  const receipt = context.runtime.submitDraft(student, activityId, input);
  context.checkpoint?.({ point: "afterConfirmationCommit", operationId: input.operationId });
  context.scheduleEvaluation();
  return receipt;
}

function identityOf({ id }: Identity) {
  return { role: "student" as const, id };
}

function requireSameIdentity(request: IncomingMessage, context: HostContext, expected: Identity) {
  const actor = authenticate(request, context.lookup);
  if (actor.role !== expected.role || actor.id !== expected.id) throw new LearningError(403, "FORBIDDEN");
}
