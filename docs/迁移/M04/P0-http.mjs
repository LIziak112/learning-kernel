import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = "49a3fb0721c16cf9a2ba4f3d1f4fe89c471e3908";
assert.ok(process.argv[2], "Pass the locked OwnClass checkout.");
const product = resolve(process.argv[2]);

const load = (path) => import(pathToFileURL(join(product, path)).href);
const [
  { createApp },
  { createDb },
  { createTestDb },
  { createStudent, extractSessionToken, loginStudent },
  { fetchSubmitRevisions },
  { gzipJson, noteDoc, putNoteBodyForm },
  contract,
] = await Promise.all([
  load("apps/server/src/app.ts"),
  load("apps/server/src/db/client.ts"),
  load("apps/server/src/db/test-utils.ts"),
  load("apps/server/src/test/note-world.ts"),
  load("apps/server/src/test/submit-revisions.ts"),
  load("apps/server/src/test/note-fixtures.ts"),
  load("packages/contract/src/index.ts"),
]);
const requireProduct = createRequire(join(product, "apps/server/package.json"));
const dir = mkdtempSync(join(tmpdir(), "ownclass-m04-p0-"));
const database = join(dir, "attempt.sqlite");
const template = createTestDb();
writeFileSync(database, template.$client.serialize());
template.$client.close();
const db = createDb(database);
const server = createApp({
  db,
  dataDir: dir,
  logger: requireProduct("pino")({ enabled: false }),
  isProduction: false,
  publicUrl: "http://localhost:8787",
});

const requests = {};
const app = {
  async request(...args) {
    const response = await server.request(...args);
    requests[response.status] = (requests[response.status] ?? 0) + 1;
    return response;
  },
};
async function call(method, path, cookie, body, status = 200, headers = {}) {
  const request = { method, headers: { ...headers } };
  if (cookie) request.headers.cookie = cookie;
  if (body instanceof FormData) {
    request.body = body;
  } else if (body !== undefined) {
    request.headers["content-type"] = "application/json";
    request.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await app.request(path, request);
  const json = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(json)}`);
  assert.equal(json.ok, status < 400);
  if (status >= 400) {
    assert.equal(Object.hasOwn(json, "data"), false);
    assert.doesNotMatch(JSON.stringify(json), noPublication);
  }
  return { response, json, data: json.data };
}

const targetQuestions = ["m04-p0-q1", "m04-p0-q2"];
const choice = (index) => ({ kind: "choice", index });
const read = (path, cookie, status) => call("GET", path, cookie, undefined, status);
const resultRows = (result) => result.units.flatMap((unit) => unit.questions);
const query = (text, ...params) => db.$client.prepare(text).all(...params);
const teacherBase = "/api/teacher";
const studentBase = "/api/student";
const attempts = (id) => `${studentBase}/attempts/${id}`;
const dueFuture = "2099-01-01T00:00:00.000Z";
const duePast = "2020-01-01T00:00:00.000Z";
const noPublication = /合成详解[甲乙]|"(?:hints|sourceMd|bodyPath|passwordHash|linkToken)"\s*:/u;

const setup = await call("POST", "/api/public/teacher/setup", undefined, {
  loginName: "teacher",
  password: "teacher-pass-8",
});
const teacher = "tutor_session=" + extractSessionToken(setup.response);
const markdown = readFileSync(new URL("./P0-单选夹具.md", import.meta.url), "utf8");
const imported = await call("POST", teacherBase + "/import/commit", teacher, { markdown, filename: "M04P0.md" });
assert.equal(imported.data.units.length, 1);
const unitId = imported.data.units[0].id;
const aliceId = await createStudent(app, teacher, "合成甲");
const bobId = await createStudent(app, teacher, "合成乙");
const alice = await loginStudent(app, "合成甲");
const bob = await loginStudent(app, "合成乙");
const capabilityPath = teacherBase + "/settings/capability-profile";

async function setInk(enabled) {
  const profile = { enabledCapabilities: enabled ? ["ink"] : [] };
  assert.deepEqual((await call("PUT", capabilityPath, teacher, profile)).data, profile);
}

async function assign(title, studentId, withheld = false) {
  const policy = withheld ? { answerRelease: "after_due", dueAt: dueFuture } : { answerRelease: "on_submit" };
  const { data } = await call("POST", teacherBase + "/assignments", teacher, {
    title,
    unitIds: [unitId],
    studentIds: [studentId],
    allowPerQuestionFeedback: false,
    allowRedo: false,
    ...policy,
  }, 201);
  assert.equal(data.assignments.length, 1);
  return data.assignments[0].id;
}

async function start(assignmentId, cookie, oldClient = false) {
  const url = `${studentBase}/assignments/${assignmentId}/attempt`;
  const options = oldClient ? undefined : { workflowVersion: 1, feedbackMode: "after_attempt" };
  const headers = oldClient ? {} : { "x-tutor-snapshot-proof": "1" };
  const started = await call("POST", url, cookie, options, 200, headers);
  const same = await call("POST", url, cookie, options, 200, headers);
  const attempt = contract.attemptStartOkSchema.parse(started.json).data;
  assert.equal(same.data.id, attempt.id);
  assert.equal(attempt.status, "draft");
  return attempt;
}

async function draft(id, cookie) {
  const { json } = await read(attempts(id), cookie);
  assert.doesNotMatch(JSON.stringify(json), noPublication);
  const data = contract.attemptDraftOkSchema.parse(json).data;
  assert.equal(data.attempt.id, id);
  assert.equal(data.attempt.status, "draft");
  const questions = resultRows(data);
  assert.deepEqual(questions.map(({ id, type }) => [id, type]), targetQuestions.map((id) => [id, "choice"]));
  assert.ok(questions.every(({ questionRevisionId }) => questionRevisionId));
  return data;
}

async function save(data, cookie, index, answerIndex, oldClient = false) {
  const question = resultRows(data)[index];
  const body = {
    answer: choice(answerIndex),
    baseRevision: data.draftRevisions?.[question.id] ?? 0,
    mutationId: randomUUID(),
    ...(oldClient ? {} : {
      questionRevisionId: question.questionRevisionId,
      expectedFrozenAt: data.attempt.frozenAt,
    }),
  };
  if (!oldClient) assert.ok(body.expectedFrozenAt);
  const url = attempts(data.attempt.id) + "/answers/" + question.id;
  const saved = await call("PUT", url, cookie, body);
  assert.equal(saved.data.revision, body.baseRevision + 1);
  assert.deepEqual((await call("PUT", url, cookie, body)).data, saved.data);
  return saved.data;
}

function facts(id) {
  return {
    attempt: query("SELECT status, submitted_at, score_auto, score_final FROM attempts WHERE id = ?", id),
    responses: query("SELECT id, question_id, answer_json, answer_revision, change_count, answered, auto_correct, final_correct, settlement_seq FROM responses WHERE attempt_id = ? ORDER BY question_id", id),
    evidence: query("SELECT question_id, state, version_id FROM submission_evidence WHERE attempt_id = ? ORDER BY question_id", id),
    settlements: query("SELECT id, seq, kind, question_count FROM attempt_settlements WHERE attempt_id = ?", id),
    events: query("SELECT id, type, payload_json FROM events WHERE attempt_id = ? AND type = 'submit'", id),
  };
}

async function submit(id, cookie, answers, recentNote) {
  const revisions = await fetchSubmitRevisions(app, cookie, id);
  assert.deepEqual(revisions.map((revision) => revision.questionId), targetQuestions);
  const evidence = targetQuestions.map((questionId, index) => recentNote && index === 0
    ? { questionId, state: "frozen", versionId: recentNote.versionId, revision: recentNote.revision }
    : { questionId, state: "none" });
  const wire = JSON.stringify({ revisions, evidence });
  const url = attempts(id) + "/submit";
  const before = facts(id);
  assert.equal(before.attempt.length, 1);
  assert.equal(before.responses.length, 2);
  assert.ok(before.responses.every((row) => row.auto_correct === null && row.final_correct === null));
  assert.deepEqual([before.evidence.length, before.settlements.length, before.events.length], [0, 0, 0]);
  const { json } = await call("POST", url, cookie, wire);
  const result = contract.attemptResultOkSchema.parse(json).data;
  const after = facts(id);
  const replay = await call("POST", url, cookie, wire, 409);
  assert.equal(replay.json.error, "ALREADY_SUBMITTED");
  assert.deepEqual(facts(id), after);
  assert.equal(after.attempt.length, 1);
  assert.equal(after.attempt[0].status, "graded");
  assert.ok(after.attempt[0].submitted_at);
  assert.deepEqual(after.responses.map(({ id: rowId }) => rowId), before.responses.map(({ id: rowId }) => rowId));
  assert.deepEqual(after.responses.map(({ answer_json }) => answer_json === null ? null : JSON.parse(answer_json)), answers);
  assert.deepEqual(after.responses.map(({ answered }) => answered), answers.map((answer) => Number(answer !== null)));
  assert.equal(after.evidence.length, 2);
  assert.deepEqual(after.evidence.map(({ state }) => state), [recentNote ? "frozen" : "none", "none"]);
  assert.equal(after.settlements.length, 1);
  assert.equal(after.settlements[0].kind, "final");
  assert.equal(after.settlements[0].question_count, 2);
  assert.equal(after.events.length, 1);
  assert.equal(JSON.parse(after.events[0].payload_json).confirmed, true);
  assert.deepEqual(resultRows(result).map(({ answer }) => answer), answers);
  return { result, after, wireHash: createHash("sha256").update(wire).digest("hex"), wire };
}

async function result(id, cookie) {
  return contract.attemptResultOkSchema.parse((await read(attempts(id), cookie)).json).data;
}

async function teacherResult(id) {
  const detail = await read(`${teacherBase}/attempts/${id}`, teacher);
  return contract.teacherAttemptDetailOkSchema.parse(detail.json).data;
}

async function readRecords(cookie) {
  const { json } = await read(studentBase + "/records", cookie);
  assert.doesNotMatch(JSON.stringify(json), noPublication);
  return contract.studentRecordsOkSchema.parse(json).data;
}

async function wrongBook(cookie) {
  const { json } = await read(studentBase + "/wrong-questions?includeResolved=true", cookie);
  return contract.wrongQuestionsOkSchema.parse(json).data.questions;
}

async function statistics() {
  const overview = (await read(teacherBase + "/analytics/overview?days=all", teacher)).data;
  const details = (await read(teacherBase + "/analytics/questions?days=all", teacher)).data;
  const { overall: { judgedCount, correctCount, correctRate } } = contract.analyticsOverviewDataSchema.parse(overview);
  const { questions } = contract.analyticsQuestionsDataSchema.parse(details);
  return {
    judgedCount, correctCount, correctRate,
    questions: questions.map(({ questionId, submittedCount, judgedCount, correctCount }) => ({
      questionId, submittedCount, judgedCount, correctCount,
    })),
  };
}

function assertWithheld(data, ownAnswers) {
  assert.equal(data.answersReleased, false);
  assert.equal(data.dueAt, dueFuture);
  assert.equal(data.attempt.scoreAuto, null);
  assert.equal(data.summary.scoreFinal, null);
  assert.equal(data.summary.pendingCount, null);
  assert.deepEqual([data.summary.correct, data.summary.wrong, data.summary.autoGradable], [0, 0, 0]);
  assert.deepEqual(resultRows(data).map(({ answer }) => answer), ownAnswers);
  for (const row of resultRows(data)) {
    for (const key of ["answers", "solutionMd", "autoCorrect", "finalCorrect", "teacherMark", "teacherComment"]) {
      assert.equal(row[key], null, key);
    }
  }
  assert.doesNotMatch(JSON.stringify(data), noPublication);
}

function decision(submission, expectedScore, expectedVerdicts) {
  const { after, result, wireHash } = submission;
  const scores = [after.attempt[0].score_auto, after.attempt[0].score_final];
  const verdicts = after.responses.map(({ auto_correct }) => auto_correct);
  assert.deepEqual(scores, [expectedScore, expectedScore]);
  assert.deepEqual(verdicts, expectedVerdicts);
  assert.deepEqual(after.responses.map(({ final_correct }) => final_correct), expectedVerdicts);
  assert.deepEqual(after.responses.map(({ settlement_seq }) => settlement_seq), [1, 1]);
  assert.ok(after.responses.every(({ change_count, answer_revision }) => change_count === answer_revision));
  return {
    score: scores[0], summary: result.summary,
    answered: after.responses.map(({ answered }) => answered),
    answerRevisions: after.responses.map(({ answer_revision }) => answer_revision),
    verdicts, evidence: after.evidence.map(({ state }) => state),
    counts: Object.fromEntries(Object.entries(after).map(([key, rows]) => [key, rows.length])),
    wireHash, replay: "409 ALREADY_SUBMITTED",
  };
}
export {
  app, source, database, db, requests, call, read, query, teacherBase, studentBase,
  teacher, aliceId, bobId, alice, bob, unitId, targetQuestions, choice, attempts,
  dueFuture, duePast, setInk, assign, start, draft, save, facts, submit, result,
  teacherResult, readRecords, wrongBook, statistics, assertWithheld, decision,
  fetchSubmitRevisions, gzipJson, noteDoc, putNoteBodyForm, resultRows,
};
