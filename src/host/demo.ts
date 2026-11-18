import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
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
]);

export function createDemoServer(databasePath: string, evaluateAutomatically = true) {
  const student = randomUUID();
  const other = randomUUID();
  const libraryEntry = `/?practice=${library.practice.id}`;
  const profiles = new Map([
    ["/demo/student", { token: student, location: "/" }],
    ["/demo/other", { token: other, location: "/" }],
    ["/demo/reading", { token: student, location: libraryEntry }],
  ]);
  return createLearningServer({
    databasePath,
    publication,
    additionalPublications: [library],
    sessions: new Map([[student, "student-1"], [other, "student-2"]]),
    assignedReviewer: "teacher-1",
    evaluateAutomatically,
    servePage(request, response, path) {
      if (request.method !== "GET") return false;
      const profile = profiles.get(path);
      if (profile) {
        response.writeHead(303, {
          Location: profile.location,
          "Cache-Control": "no-store",
          "Set-Cookie": `learning_session=${profile.token}; Path=/; HttpOnly; SameSite=Strict`,
        });
        response.end();
        return true;
      }
      if (path === "/demo/entry") {
        const requested = new URL(request.url ?? "/", "http://localhost").searchParams.get("practice");
        const practiceId = requested === library.practice.id ? library.practice.id : publication.practice.id;
        sendJSON(response, 200, { practiceId });
        return true;
      }
      return sendAsset(response, pagePath.test(path) ? "/" : path);
    },
  });
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
