import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { startInput, saveInput, submitInput } from "../contracts/reading.ts";
import { startActivity } from "../kernel/activity.ts";
import { openDatabase } from "../kernel/database.ts";
import { LearningError } from "../kernel/learning-error.ts";
import { registerPublication } from "../kernel/publication.ts";
import { readActivity, readSubmission, saveDraft, submitDraft } from "../kernel/submission.ts";
import { readJSON, sendJSON, sendError, studentFor } from "./http.ts";

export function createLearningServer(options: {
  databasePath: string;
  publication: unknown;
  sessions: ReadonlyMap<string, string>;
}) {
  const database = openDatabase(options.databasePath);
  try {
    registerPublication(database, options.publication);
  } catch (error) {
    database.close();
    throw error;
  }
  const server = createServer((request, response) => {
    serve(request, response, database, options.sessions).catch(error => sendError(response, error));
  });
  server.once("close", () => database.close());
  return server;
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  database: DatabaseSync,
  sessions: ReadonlyMap<string, string>,
) {
  const path = new URL(z.string().parse(request.url), "http://localhost").pathname;
  const student = studentFor(request, sessions);
  if (request.method === "POST" && path === "/api/activities") {
    const input = startInput.parse(await readJSON(request));
    return sendJSON(response, 200, startActivity(database, student, input));
  }
  const match = path.match(
    /^\/api\/activities\/([a-f0-9-]{36})(?:\/(drafts|submissions)(?:\/([a-f0-9-]{36}))?)?$/,
  );
  if (!match) throw new LearningError(404, "NOT_FOUND");
  const [, identifier, resource, submissionId] = match;
  const activityId = z.uuid().parse(identifier);
  const data = request.method === "GET"
    ? get(database, student, activityId, resource, submissionId)
    : await post(request, database, student, activityId, resource, submissionId);
  return sendJSON(response, 200, data);
}

function get(database: DatabaseSync, student: string, activityId: string, resource?: string, submissionId?: string) {
  if (!resource) return readActivity(database, student, activityId);
  if (resource === "submissions" && submissionId) return readSubmission(database, student, activityId, submissionId);
  throw new LearningError(404, "NOT_FOUND");
}

async function post(
  request: IncomingMessage,
  database: DatabaseSync,
  student: string,
  activityId: string,
  resource?: string,
  submissionId?: string,
) {
  if (request.method !== "POST" || submissionId) throw new LearningError(404, "NOT_FOUND");
  if (resource === "drafts") {
    const input = saveInput.parse(await readJSON(request));
    return saveDraft(database, student, activityId, input);
  }
  if (resource === "submissions") {
    const input = submitInput.parse(await readJSON(request));
    return submitDraft(database, student, activityId, input);
  }
  throw new LearningError(404, "NOT_FOUND");
}
