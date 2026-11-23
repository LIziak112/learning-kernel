import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import publication from "../../practices/single-quote.json" with { type: "json" };
import library from "../../practices/reading-library.json" with { type: "json" };
import { sendJSON } from "./http.ts";
import { createLearningServer } from "./server.ts";

const pagePath = /^\/activities\/[a-f0-9-]{36}$/;
const assets = new Map([
  ["/", { file: "index.html", type: "text/html" }],
  ["/reading.css", { file: "reading.css", type: "text/css" }],
  ["/reading.mjs", { file: "reading.mjs", type: "text/javascript" }],
  ["/library-reading.mjs", { file: "library-reading.mjs", type: "text/javascript" }],
  ["/api.mjs", { file: "api.mjs", type: "text/javascript" }],
  ["/review", { file: "teacher.html", type: "text/html" }],
  ["/teacher.mjs", { file: "teacher.mjs", type: "text/javascript" }],
]);

type DemoOptions = Pick<Parameters<typeof createLearningServer>[0],
  "evaluateAutomatically" | "clock" | "reviewerSessions" | "additionalPublications">;
const entryDeclaration = z.object({ practice: z.object({ id: z.string() }) });

export function createDemoServer(databasePath: string, options: DemoOptions = {}) {
  const student = randomUUID();
  const other = randomUUID();
  const teacher = randomUUID();
  const { additionalPublications = [], reviewerSessions, ...runtime } = options;
  const published = [library, ...additionalPublications];
  const entryIds = new Set(published.map(item => entryDeclaration.parse(item).practice.id));
  const profiles = new Map([
    ["/demo/student", { token: student, location: "/" }],
    ["/demo/other", { token: other, location: "/" }],
    ["/demo/reading", { token: student, location: "/?practice=" + library.practice.id }],
    ["/demo/teacher", { token: teacher, location: "/review" }],
  ]);
  return createLearningServer({
    databasePath,
    publication,
    additionalPublications: published,
    sessions: new Map([[student, "student-1"], [other, "student-2"]]),
    reviewerSessions: new Map([[teacher, "teacher-1"], ...(reviewerSessions ?? [])]),
    assignedReviewer: "teacher-1",
    ...runtime,
    servePage(request, response, path) {
      if (request.method !== "GET") return false;
      const practiceId = requestedEntry(request.url, entryIds);
      const profile = profiles.get(path);
      if (profile) {
        const location = path === "/demo/reading" && practiceId
          ? "/?" + new URLSearchParams({ practice: practiceId })
          : profile.location;
        return enterDemo(response, profile.token, location);
      }
      if (path === "/demo/entry") {
        sendJSON(response, 200, { practiceId: practiceId ?? publication.practice.id });
        return true;
      }
      return sendAsset(response, pagePath.test(path) ? "/" : path);
    },
  });
}

function requestedEntry(url: string | undefined, entries: ReadonlySet<string>) {
  const requested = new URL(url ?? "/", "http://localhost").searchParams.get("practice");
  return requested && entries.has(requested) ? requested : undefined;
}

function enterDemo(response: ServerResponse, token: string, location: string) {
  response.writeHead(303, {
    Location: location,
    "Cache-Control": "no-store",
    "Set-Cookie": `learning_session=${token}; Path=/; HttpOnly; SameSite=Strict`,
  });
  response.end();
  return true;
}

function sendAsset(response: ServerResponse, path: string) {
  const asset = assets.get(path);
  if (!asset) return false;
  const body = readFileSync(new URL(`./web/${asset.file}`, import.meta.url));
  response.writeHead(200, {
    "Content-Type": `${asset.type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
  return true;
}
