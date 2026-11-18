import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import publication from "../../practices/single-quote.json" with { type: "json" };
import { sendJSON } from "./http.ts";
import { createLearningServer } from "./server.ts";

const pagePath = /^\/activities\/[a-f0-9-]{36}$/;
const assets = new Map([
  ["/", { file: "index.html", type: "text/html" }],
  ["/reading.css", { file: "reading.css", type: "text/css" }],
  ["/reading.mjs", { file: "reading.mjs", type: "text/javascript" }],
]);

export function createDemoServer(databasePath: string) {
  const profiles = [
    { path: "/demo/student", student: "student-1", token: randomUUID() },
    { path: "/demo/other", student: "student-2", token: randomUUID() },
  ];
  const sessions = new Map(profiles.map(profile => [profile.token, profile.student]));
  return createLearningServer({
    databasePath,
    publication,
    sessions,
    servePage(request, response, path) {
      if (request.method !== "GET") return false;
      const profile = profiles.find(entry => entry.path === path);
      if (profile) {
        response.writeHead(303, {
          Location: "/",
          "Cache-Control": "no-store",
          "Set-Cookie": `learning_session=${profile.token}; Path=/; HttpOnly; SameSite=Strict`,
        });
        response.end();
        return true;
      }
      if (path === "/demo/entry") {
        sendJSON(response, 200, { practiceId: publication.practice.id });
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
