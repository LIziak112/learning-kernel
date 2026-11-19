import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  app, source, database, db, requests, call, read, query, teacherBase, studentBase,
  teacher, aliceId, bobId, alice, bob, unitId, targetQuestions, choice, attempts,
  duePast, setInk, assign, start, draft, save, facts, submit, result,
  teacherResult, readRecords, wrongBook, statistics, assertWithheld, decision,
  fetchSubmitRevisions, gzipJson, noteDoc, putNoteBodyForm, resultRows,
} from "./P0-http.mjs";

await setInk(false);
const priorAssignment = await assign("M04 P0 旧作业对照", bobId);
const prior = await start(priorAssignment, bob, true);
const priorDraft = await draft(prior.id, bob);
assert.equal(priorDraft.practiceWorkflow, undefined);
const notePath = attempts(prior.id) + "/notes/" + targetQuestions[0];
assert.deepEqual(priorDraft.enabledCapabilities, []);
assert.equal((await read(notePath, bob)).data.note, null);
await setInk(true);
assert.deepEqual((await draft(prior.id, bob)).enabledCapabilities, ["ink"]);
assert.equal((await read(notePath, bob)).data.note, null);
const note1 = (await call("PUT", notePath, bob, putNoteBodyForm(gzipJson(noteDoc(1))))).data;
assert.equal(note1.revision, 1);
await setInk(false);
assert.deepEqual((await draft(prior.id, bob)).enabledCapabilities, []);
const head = (await read(notePath, bob)).data;
const note2 = (await call("PUT", notePath, bob, putNoteBodyForm(gzipJson(noteDoc(2)), { baseRevision: 1 }))).data;
assert.equal(note2.revision, 2);
assert.equal((await read(notePath, bob)).data.note.revision, 2);
assert.equal(head.note.revision, 1);
const notesWritten = query("SELECT n.current_revision, COUNT(v.id) AS versions FROM notes n JOIN note_versions v ON v.note_id = n.id WHERE n.attempt_id = ? GROUP BY n.id", prior.id);
assert.deepEqual(notesWritten, [{ current_revision: 2, versions: 2 }]);
await save(await draft(prior.id, bob), bob, 0, 1, true);
await save(await draft(prior.id, bob), bob, 1, 2, true);
const control = await submit(prior.id, bob, [choice(1), choice(2)], note2);
assert.equal(control.result.answersReleased, true);
assert.equal(control.result.attempt.scoreAuto, 100);
assert.equal(control.after.evidence[0].version_id, note2.versionId);
assert.deepEqual((await result(prior.id, bob)).summary, control.result.summary);
const beforeStats = await statistics();
assert.deepEqual([beforeStats.judgedCount, beforeStats.correctCount], [2, 2]);

const initialAssignment = await assign("M04 P0 两题完整", aliceId, true);
const normal = await start(initialAssignment, alice);
const normalDraft = await draft(normal.id, alice);
assert.deepEqual(normalDraft.drafts, {});
assert.equal(normalDraft.practiceWorkflow.feedbackMode, "after_attempt");
assert.equal(normalDraft.practiceWorkflow.canSubmitQuestion, false);
assert.equal(normalDraft.practiceWorkflow.canSettlePartially, false);
assert.equal(normalDraft.attempt.phase, "opened");
const beforeSave = await readRecords(alice);
assert.equal(beforeSave.total, 0);
const exceptAssignee = await call("POST", `${studentBase}/assignments/${initialAssignment}/attempt`, bob, undefined, 403);
const first = await save(normalDraft, alice, 0, 0);
const refreshed = await draft(normal.id, alice);
assert.equal(refreshed.attempt.phase, "active");
assert.deepEqual(refreshed.drafts, { [targetQuestions[0]]: choice(0) });
assert.equal(refreshed.draftRevisions[targetQuestions[0]], first.revision);
assert.equal((await readRecords(alice)).total, 1);
const second = await save(refreshed, alice, 0, 1);
assert.equal(second.revision, 2);
await save(await draft(normal.id, alice), alice, 1, 0);
const current = await fetchSubmitRevisions(app, alice, normal.id);
const preConflict = facts(normal.id);
const oldRevision = current.map((item, index) => index === 0 ? { ...item, expectedAnswerRevision: 1 } : item);
const submitPath = attempts(normal.id) + "/submit";
const staleAnswer = await call("POST", submitPath, alice, { revisions: oldRevision }, 409);
assert.equal(staleAnswer.json.error, "ANSWER_REVISION_CONFLICT");
assert.deepEqual(staleAnswer.json._current, { revision: 2, draft: choice(1) });
const staleQuestion = current.map((item, index) => index === 0 ? { ...item, questionRevisionId: randomUUID() } : item);
assert.equal((await call("POST", submitPath, alice, { revisions: staleQuestion }, 409)).json.error, "QUESTION_REVISION_STALE");
assert.deepEqual(facts(normal.id), preConflict);
const completeAnswers = [choice(1), choice(0)];
const submitted = await submit(normal.id, alice, completeAnswers);
assertWithheld(submitted.result, completeAnswers);
const withheld = await result(normal.id, alice);
assertWithheld(withheld, completeAnswers);
assert.deepEqual(withheld.summary, submitted.result.summary);
const denied = {
  start: exceptAssignee.json.error,
  detail: (await read(attempts(normal.id), bob, 403)).json.error,
  replay: (await call("POST", submitPath, bob, submitted.wire, 403)).json.error,
  loggedOut: (await read(attempts(normal.id), undefined, 401)).json.error,
  studentTeacherDetail: (await read(`${teacherBase}/attempts/${normal.id}`, alice, 401)).json.error,
};
const recordHidden = await readRecords(alice);
assert.equal(recordHidden.total, 1);
assert.equal(recordHidden.records[0].attemptId, normal.id);
assert.equal(recordHidden.records[0].answersReleased, false);
assert.equal(recordHidden.records[0].score, null);
assert.equal(recordHidden.records[0].pendingCount, null);
assert.equal(recordHidden.records[0].resultCounts, null);
assert.deepEqual(await wrongBook(alice), []);
const teacherBeforeRelease = await teacherResult(normal.id);
assert.equal(teacherBeforeRelease.studentId, aliceId);
assert.deepEqual([teacherBeforeRelease.scoreAuto, teacherBeforeRelease.scoreFinal], [50, 50]);
assert.deepEqual(teacherBeforeRelease.questions.map(({ finalCorrect }) => finalCorrect), [true, false]);
assert.deepEqual(teacherBeforeRelease.questions.map(({ answers }) => answers), [choice(1), choice(2)]);
assert.equal((await readRecords(bob)).records[0].attemptId, prior.id);
assert.deepEqual(await wrongBook(bob), []);
const withheldStats = await statistics();
assert.deepEqual([withheldStats.judgedCount, withheldStats.correctCount], [4, 3]);

await call("PATCH", `${teacherBase}/assignments/${initialAssignment}`, teacher, { dueAt: duePast });
const published = await result(normal.id, alice);
assert.equal(published.dueAt, duePast);
assert.equal(published.answersReleased, true);
assert.equal(published.attempt.scoreAuto, 50);
assert.deepEqual(resultRows(published).map(({ answer }) => answer), completeAnswers);
assert.deepEqual(resultRows(published).map(({ answers }) => answers), [choice(1), choice(2)]);
assert.deepEqual(resultRows(published).map(({ autoCorrect }) => autoCorrect), [true, false]);
assert.deepEqual(resultRows(published).map(({ solutionMd }) => solutionMd), teacherBeforeRelease.questions.map(({ solutionMd }) => solutionMd));
const publishedRecord = (await readRecords(alice)).records[0];
assert.deepEqual([publishedRecord.attemptId, publishedRecord.answersReleased, publishedRecord.score, publishedRecord.pendingCount], [normal.id, true, 50, 0]);
const publishedWrong = await wrongBook(alice);
assert.deepEqual(publishedWrong.map(({ questionId, wrongCount, rounds }) => [questionId, wrongCount, rounds.length]), [[targetQuestions[1], 1, 1]]);
assert.deepEqual(await statistics(), withheldStats);
assert.equal((await read(attempts(normal.id), bob, 403)).json.error, denied.detail);
assert.deepEqual(facts(normal.id), submitted.after);

const emptyAssignment = await assign("M04 P0 全空", aliceId);
const empty = await start(emptyAssignment, alice);
assert.deepEqual((await draft(empty.id, alice)).drafts, {});
const emptySubmission = await submit(empty.id, alice, [null, null]);
assert.equal(emptySubmission.result.answersReleased, true);
const emptyTeacher = await teacherResult(empty.id);
assert.deepEqual([emptyTeacher.correctCount, emptyTeacher.wrongCount, emptyTeacher.notDoneCount], [0, 0, 2]);

const partialAssignment = await assign("M04 P0 部分作答", aliceId);
const partial = await start(partialAssignment, alice);
await save(await draft(partial.id, alice), alice, 0, 1);
const partialSubmission = await submit(partial.id, alice, [choice(1), null]);
assert.equal(partialSubmission.result.answersReleased, true);
const partialTeacher = await teacherResult(partial.id);
assert.deepEqual([partialTeacher.correctCount, partialTeacher.wrongCount, partialTeacher.notDoneCount], [1, 0, 1]);

const finalRecords = await readRecords(alice);
assert.equal(finalRecords.total, 3);
assert.deepEqual(finalRecords.records.map(({ score }) => score).sort((left, right) => left - right), [0, 50, 50]);
assert.deepEqual((await readRecords(bob)).records.map(({ attemptId }) => attemptId), [prior.id]);
const finalWrong = await wrongBook(alice);
assert.deepEqual(finalWrong.map(({ questionId, wrongCount }) => [questionId, wrongCount]), [[targetQuestions[1], 1]]);
const wrongRounds = finalWrong[0].rounds.map(({ attemptId, answered, correct }) => [attemptId, answered, correct]);
assert.deepEqual(new Map(wrongRounds.map(([id, ...round]) => [id, round])), new Map([
  [normal.id, [true, false]],
  [empty.id, [false, false]],
  [partial.id, [false, false]],
]));
assert.equal(wrongRounds.length, 3);
const finalStats = await statistics();
assert.deepEqual([finalStats.judgedCount, finalStats.correctCount], [8, 4]);
assert.deepEqual(finalStats.questions.map(({ submittedCount, judgedCount, correctCount }) => [submittedCount, judgedCount, correctCount]), [[4, 4, 3], [4, 4, 1]]);
const reopened = await call("POST", `${studentBase}/assignments/${initialAssignment}/attempt`, alice, { workflowVersion: 1, feedbackMode: "after_attempt" }, 200, { "x-tutor-snapshot-proof": "1" });
assert.equal(reopened.data.id, normal.id);
assert.equal(reopened.data.status, "graded");
assert.deepEqual(facts(normal.id), submitted.after);

const frozenInput = {
  unitId,
  questions: teacherBeforeRelease.questions.map(({ publicQuestion, answers, solutionMd }) => ({
    id: publicQuestion.id,
    type: publicQuestion.type,
    version: publicQuestion.questionVersion,
    stemMd: publicQuestion.stemMd,
    options: publicQuestion.options,
    answers, solutionMd,
  })),
  cases: { complete: completeAnswers, empty: [null, null], partial: [choice(1), null] },
};
assert.ok(frozenInput.questions.every(({ version, options }) => version === 1 && options.length === 3));
const expectedInput = JSON.parse(readFileSync(new URL("./P0-冻结单选.json", import.meta.url), "utf8"));
assert.deepEqual(frozenInput, expectedInput);

console.log(JSON.stringify({
  source, database, runtime: process.version,
  sqlite: query("SELECT sqlite_version() AS version")[0].version,
  requests,
  fields: {
    start: Object.keys(normal),
    draft: Object.keys(normalDraft),
    save: Object.keys(first),
    withheld: Object.keys(withheld),
    teacher: Object.keys(teacherBeforeRelease),
    records: Object.keys(recordHidden.records[0]),
  },
  capabilities: {
    enabledCapabilities: [priorDraft.enabledCapabilities, ["ink"], []],
    noteRevisions: [note1.revision, note2.revision],
    frozenHead: control.after.evidence[0].version_id,
  },
  denied,
  control: decision(control, 100, [1, 1]),
  normal: decision(submitted, 50, [1, 0]),
  empty: decision(emptySubmission, 0, [0, 0]),
  partial: decision(partialSubmission, 50, [1, 0]),
  publication: { withheld: withheld.summary, published: published.summary },
  records: [beforeSave.total, recordHidden.total, finalRecords.total],
  wrong: { firstPublishedRounds: publishedWrong[0].rounds.length, finalWrongCount: finalWrong[0].wrongCount, finalRounds: wrongRounds.length },
  statistics: { beforeStats, withheldStats, finalStats },
  frozenInput,
}, null, 2));
db.$client.close();
