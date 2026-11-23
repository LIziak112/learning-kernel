import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { openLearningRuntime } from "learning-kernel";
import type { PublicationInput } from "learning-kernel";
import { z } from "zod";

const phase = z.enum(["write", "recover"]).parse(process.argv[2]);
const owner = { role: "student", id: "independent-reader" } as const;
const protocolVersion = 1;
const practiceId = "material-pair";
const evaluator = { id: "independent-choice-evaluator", version: 1 };
const first = { id: "reading-a", version: 1, source: "fixture A", title: "材料甲",
  paragraphs: [{ id: "p", text: "甲固定正文。" }] };
const second = { id: "reading-b", version: 1, source: "fixture B", title: "材料乙",
  paragraphs: [{ id: "p", text: "乙初版正文。" }] };
const secondUpdated = { ...second, version: 2, paragraphs: [{ id: "p", text: "乙新版正文。" }] };

function publication(material = second, version = 1) {
  const key = { id: "material-pair-key", version };
  return {
    materials: [first, material],
    scoringKey: { ...key, acceptedChoices: { question: "known" } },
    practice: {
      id: practiceId, version, formatVersion: 1, title: "固定两份材料",
      goals: { answer: "确认作答" },
      questions: [{ id: "question", version: 1, prompt: "根据两份材料选择。", options: { known: "甲", other: "乙" } }],
      steps: [{ id: "answer", instructions: "先读再答", tool: { id: "single-choice-group", version: 1 },
        inputs: {
          first: { from: "material", positionId: "first-position", material: { id: first.id, version: first.version } },
          second: { from: "material", positionId: "second-position", material: { id: material.id, version: material.version } },
          questions: { from: "questions" },
        },
        submit: { purpose: "finalAnswer", slots: { answers: {
          type: "oneChoicePerQuestion", source: "questions", targetId: "answer", confirmFromDrafts: { allowUnanswered: false },
        } } }, afterConfirmation: "finish",
      }],
      grading: { assessment: {
        from: { stepId: "answer", slotId: "answers" }, evaluator, keyRef: key, unit: "question",
        effectiveVerdictOrder: ["teacherReview", "automatic"],
      } },
      policy: { offline: "onlineOnly", redo: "newInstanceOnAuthorization", externalAi: "disabled",
        student: { ownSubmission: { scope: "ownConfirmedSubmissions", fields: ["receipt"], onFinal: [] } },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] }, manager: { scope: "assigningTeacher", actions: [] },
      },
    },
  } satisfies PublicationInput;
}

const runtime = openLearningRuntime({ databasePath: "material-pair.sqlite",
  evaluators: [{ ...evaluator, responseTypes: ["choice"], evaluate: ({ value, key }) => ({ status: "judged", correct: value === z.object({ acceptedChoice: z.string() }).parse(key).acceptedChoice }) }],
});
const opening = (practiceVersion: number) => ({
  protocolVersion, practiceId, practiceVersion, operationId: `open-${practiceVersion}`,
}) as const;
const data = "material-pair-openings.json";
const receipt = z.strictObject({ activityId: z.uuid(), stepAttemptId: z.uuid(), startedAt: z.iso.datetime() });
function read(activityId: string, material = second) {
  const result = runtime.read(owner, activityId);
  assert.ok("formatVersion" in result);
  assert.deepEqual(result.inputs.first, { from: "material", positionId: "first-position", material: first });
  assert.deepEqual(result.inputs.second, { from: "material", positionId: "second-position", material });
  assert.equal(result.material, undefined);
  assert.deepEqual(Object.keys(result.inputs).sort(), ["first", "questions", "second"]);
  assert.doesNotMatch(JSON.stringify(result), /scoringKey|acceptedChoices|acceptedChoice/);
  return result;
}
try {
  if (phase === "write") {
    runtime.publish(publication());
    const original = runtime.prepare(owner, opening(1));
    assert.equal(runtime.saveCurrentChoiceDraft(owner, original.activityId, {
      protocolVersion, stepAttemptId: original.stepAttemptId, slotId: "answers",
      questionId: "question", questionVersion: 1, choice: "known", baseRevision: 0, operationId: "save",
    }).revision, 1);
    runtime.publish(publication(secondUpdated, 2));
    const next = runtime.prepare(owner, opening(2));
    read(original.activityId);
    read(next.activityId, secondUpdated);
    writeFileSync(data, JSON.stringify({ original, next }));
  } else {
    const { original, next } = z.object({ original: receipt, next: receipt }).parse(JSON.parse(readFileSync(data, "utf8")));
    assert.deepEqual(runtime.prepare(owner, opening(1)), original);
    assert.deepEqual(runtime.prepare(owner, opening(2)), next);
    const previous = read(original.activityId);
    assert.ok("choiceDrafts" in previous);
    assert.equal(previous.choiceDrafts[0]?.choice, "known");
    assert.equal(previous.choiceDrafts[0]?.revision, 1);
    read(next.activityId, secondUpdated);
    assert.throws(() => runtime.read({ ...owner, id: "other" }, original.activityId), { status: 403, code: "FORBIDDEN" });
  }
} finally {
  runtime.close();
}
