import type { IncomingMessage, ServerResponse } from "node:http";
import { z, ZodError } from "zod";
import { LearningError } from "../contracts/learning-error.ts";

const httpChunk = z.instanceof(Buffer);
const maximumBodyBytes = 64 * 1024;

export function authenticate<Identity>(request: IncomingMessage, lookup: (token: string) => Identity | undefined) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)learning_session=([^;]+)/)?.[1];
  const identity = token && lookup(token);
  if (!identity) throw new LearningError(401, "UNAUTHENTICATED");
  return identity;
}

export async function readJSON(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (!contentType || !/^\s*application\/json\s*(?:;|$)/i.test(contentType)) {
    throw new LearningError(415, "JSON_REQUIRED");
  }
  const bytes: Buffer[] = [];
  let remaining = maximumBodyBytes;
  for await (const chunk of request) {
    const body = httpChunk.parse(chunk);
    remaining -= body.length;
    if (remaining < 0) throw new LearningError(413, "BODY_TOO_LARGE");
    bytes.push(body);
  }
  try {
    return JSON.parse(Buffer.concat(bytes).toString("utf8"));
  } catch {
    throw new LearningError(400, "BAD_REQUEST");
  }
}

export function sendJSON(response: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function sendError(response: ServerResponse, error: unknown) {
  if (error instanceof LearningError) return sendJSON(response, error.status, { code: error.code });
  if (error instanceof ZodError) return sendJSON(response, 400, { code: "BAD_REQUEST" });
  console.error(error);
  return sendJSON(response, 500, { code: "INTERNAL_ERROR" });
}
