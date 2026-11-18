import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { z, ZodError } from "zod";
import reading from "../practices/reading-library.json" with { type: "json" };
import { createLearningServer } from "../src/host/server.ts";
import { openDatabase } from "../src/kernel/database.ts";
import { registerPublication } from "../src/kernel/publication.ts";

test("发布两步阅读并固定材料版本、独立使用位置和前序槽位引用", t => {
  const path = databasePath(t);
  {
    using database = openDatabase(path);
    registerPublication(database, reading);
    registerPublication(database, reading);
  }
  using database = openDatabase(path);
  const material = database.prepare("SELECT id, version FROM materials").all();
  assert.deepEqual(material.map(row => [row.id, row.version]), [["library-hours", 1]]);
  const practice = database.prepare(`
    SELECT definition, material_id, material_version FROM practices WHERE id = ? AND version = ?
  `).get("reading-library", 1);
  assert.equal(practice?.material_id, "library-hours");
  assert.equal(practice?.material_version, 1);
  assert.deepEqual(JSON.parse(String(practice?.definition)), reading.practice);
  const materialUses = database.prepare(`
    SELECT json_extract(step.value, '$.inputs.passage.positionId') AS position,
      p.material_id AS material, p.material_version AS version
    FROM practices p, json_each(p.definition, '$.steps') step
    ORDER BY step.key
  `).all();
  assert.deepEqual(materialUses.map(row => [row.material, row.version, row.position]), [
    ["library-hours", 1, "evidence-passage"],
    ["library-hours", 1, "decide-passage"],
  ]);
  const keys = database.prepare("SELECT definition FROM scoring_keys").all();
  assert.deepEqual(keys.map(row => JSON.parse(String(row.definition))), [reading.scoringKey]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM practices").get()?.count, 1);
});

function databasePath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "learning-kernel-publication-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "publication.sqlite");
}

const [evidence, decide] = reading.practice.steps;
assert.ok(evidence?.submit.slots.quotes && decide?.inputs.quotes && decide.submit.slots.choices && decide.submit.slots.basis);

const slots = evidence.submit.slots;
const inputs = decide.inputs;
const grading = reading.practice.grading;
const first = ["practice", "steps", 0];
const second = ["practice", "steps", 1];
const failures: { title: string; input: unknown; path: (string | number)[] }[] = [
  {
    title: "报告槽位指向不存在的目标",
    input: withSteps({ ...evidence, submit: { ...evidence.submit, slots: { quotes: { ...slots.quotes, targetId: "missing" } } } }, decide),
    path: [...first, "submit", "slots", "quotes", "targetId"],
  },
  {
    title: "报告第二步指向不存在的已交槽位",
    input: withSteps(evidence, { ...decide, inputs: { ...inputs, quotes: { ...inputs.quotes, slotId: "missing" } } }),
    path: [...second, "inputs", "quotes", "slotId"],
  },
  {
    title: "脱离前序步骤的确认条件须拒绝",
    input: withSteps(evidence, { ...decide, requires: "missing" }),
    path: [...second, "requires"],
  },
  {
    title: "中间步骤须在确认后推进",
    input: withSteps({ ...evidence, afterConfirmation: "finish" }, decide),
    path: [...first, "afterConfirmation"],
  },
  {
    title: "步骤标识须唯一",
    input: withSteps(evidence, { ...decide, id: evidence.id }),
    path: [...second, "id"],
  },
  {
    title: "拒绝第二步引用本步骤的结果",
    input: withSteps(evidence, { ...decide, inputs: { ...inputs, quotes: { ...inputs.quotes, stepId: decide.id, slotId: "choices" } } }),
    path: [...second, "inputs", "quotes", "stepId"],
  },
  {
    title: "复用输入须直接指向前序步骤的新交付",
    input: withSteps({
      ...evidence,
      submit: { ...evidence.submit, slots: { ...slots, basis: decide.submit.slots.basis } },
    }, { ...decide, inputs: { ...inputs, quotes: { ...inputs.quotes, slotId: "basis" } } }),
    path: [...second, "inputs", "quotes", "slotId"],
  },
  {
    title: "拒绝两个步骤共用同一个材料位置",
    input: withSteps(evidence, { ...decide, inputs: { ...inputs, passage: evidence.inputs.passage } }),
    path: [...second, "inputs", "passage", "positionId"],
  },
  {
    title: "报告工具输出与选区槽位不匹配",
    input: withSteps({ ...evidence, tool: { id: "single-choice-group", version: 1 }, inputs: { ...evidence.inputs, items: inputs.items } }, decide),
    path: [...first, "submit", "slots", "quotes", "type"],
  },
  {
    title: "拒绝用单段选区工具交付多角色选区",
    input: withSteps({ ...evidence, tool: { id: "text-selection", version: 1 } }, decide),
    path: [...first, "submit", "slots", "quotes", "type"],
  },
  {
    title: "拒绝绑定未登记的工具版本",
    input: withSteps({ ...evidence, tool: { ...evidence.tool, version: 2 } }, decide),
    path: [...first, "tool"],
  },
  {
    title: "工具要求的材料输入须存在",
    input: withSteps({ ...evidence, inputs: {} }, decide),
    path: [...first, "inputs"],
  },
  {
    title: "拒绝选区工具不支持的题目输入",
    input: withSteps({ ...evidence, inputs: { ...evidence.inputs, items: inputs.items } }, decide),
    path: [...first, "inputs", "items"],
  },
  {
    title: "槽位须引用本步骤正确类型的具名输入",
    input: withSteps(evidence, {
      ...decide,
      submit: { ...decide.submit, slots: { ...decide.submit.slots, choices: { ...decide.submit.slots.choices, source: "passage" } } },
    }),
    path: [...second, "submit", "slots", "choices", "source"],
  },
  {
    title: "复用槽位不能代替工具的新交付",
    input: withSteps(evidence, { ...decide, submit: { ...decide.submit, slots: { basis: decide.submit.slots.basis } } }),
    path: [...second, "submit", "slots"],
  },
  {
    title: "拒绝同一步声明多个新交付槽位",
    input: withSteps({
      ...evidence,
      submit: { ...evidence.submit, slots: { ...slots, another: slots.quotes } },
    }, decide),
    path: [...first, "submit", "slots"],
  },
  {
    title: "复用槽位须指向已交作品输入",
    input: withSteps(evidence, {
      ...decide,
      submit: { ...decide.submit, slots: { ...decide.submit.slots, basis: { type: "reuse", source: "passage" } } },
    }),
    path: [...second, "submit", "slots", "basis", "source"],
  },
  {
    title: "禁止学生步骤绑定服务端评估器",
    input: withSteps({ ...evidence, tool: grading.assessment.evaluator }, decide),
    path: [...first, "tool"],
  },
  {
    title: "评分键只能引用存在的选项",
    input: { ...reading, scoringKey: { ...reading.scoringKey, acceptedChoices: { ...reading.scoringKey.acceptedChoices, q2: "C" } } },
    path: ["scoringKey", "acceptedChoices", "q2"],
  },
  {
    title: "评分键不得少题",
    input: { ...reading, scoringKey: { ...reading.scoringKey, acceptedChoices: { q1: "A", q3: "B" } } },
    path: ["scoringKey", "acceptedChoices", "q2"],
  },
  {
    title: "评分键不得多出无关题目",
    input: { ...reading, scoringKey: { ...reading.scoringKey, acceptedChoices: { ...reading.scoringKey.acceptedChoices, q4: "A" } } },
    path: ["scoringKey", "acceptedChoices", "q4"],
  },
  {
    title: "题目标识须唯一",
    input: { ...reading, practice: { ...reading.practice, questions: [...reading.practice.questions, reading.practice.questions[0]] } },
    path: ["practice", "questions", 3, "id"],
  },
  {
    title: "评分键版本须与评估声明一致",
    input: { ...reading, scoringKey: { ...reading.scoringKey, version: 2 } },
    path: ["practice", "grading", "assessment", "keyRef"],
  },
  {
    title: "逐题评分须绑定选择题槽位",
    input: withGrading({ ...grading, assessment: { ...grading.assessment, from: { stepId: evidence.id, slotId: "quotes" } } }),
    path: ["practice", "grading", "assessment", "from"],
  },
  {
    title: "逐题评分须绑定服务端评估器",
    input: withGrading({ ...grading, assessment: { ...grading.assessment, evaluator: decide.tool } }),
    path: ["practice", "grading", "assessment", "evaluator"],
  },
  {
    title: "逐题评分须绑定已登记的评估器版本",
    input: withGrading({
      ...grading,
      assessment: { ...grading.assessment, evaluator: { ...grading.assessment.evaluator, version: 2 } },
    }),
    path: ["practice", "grading", "assessment", "evaluator"],
  },
  {
    title: "选据评语须绑定选区槽位",
    input: withGrading({ ...grading, selectionFeedback: { ...grading.selectionFeedback, from: grading.assessment.from } }),
    path: ["practice", "grading", "selectionFeedback", "from"],
  },
  {
    title: "报告未知声明格式版本",
    input: { ...reading, practice: { ...reading.practice, formatVersion: 2 } },
    path: ["practice", "formatVersion"],
  },
  {
    title: "拒绝学生获准字段中的评分键",
    input: {
      ...reading,
      practice: {
        ...reading.practice,
        policy: {
          ...reading.practice.policy,
          student: {
            ...reading.practice.policy.student,
            ownSubmission: { ...reading.practice.policy.student.ownSubmission, fields: ["receipt", "scoringKey"] },
          },
        },
      },
    },
    path: ["practice", "policy", "student", "ownSubmission", "fields", 1],
  },
];

for (const { title, input, path } of failures) {
  test(title, t => {
    using database = openDatabase(databasePath(t));
    assert.throws(() => registerPublication(database, input), (error: unknown) => {
      assert.ok(error instanceof ZodError);
      assert.ok(error.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(path)),
        JSON.stringify(error.issues));
      return true;
    });
    assert.deepEqual(publicationCounts(database), [0, 0, 0]);
  });
}

test("评分键版本冲突时回滚同次发布的材料和练法", t => {
  const filename = databasePath(t);
  {
    using database = openDatabase(filename);
    registerPublication(database, reading);
    const material = { ...reading.material, version: 2 };
    const practice = { ...reading.practice, version: 2, material: { id: material.id, version: material.version } };
    const scoringKey = { ...reading.scoringKey, acceptedChoices: { ...reading.scoringKey.acceptedChoices, q2: "B" } };
    assert.throws(() => registerPublication(database, { material, practice, scoringKey }), /已发布.*不能更改/);
  }
  using reopened = openDatabase(filename);
  assert.deepEqual(publicationCounts(reopened), [1, 1, 1]);
  assert.deepEqual(JSON.parse(String(reopened.prepare("SELECT definition FROM scoring_keys").get()?.definition)), reading.scoringKey);
});

test("发布的两步声明经同一服务装载，学生开练只取得当前步的公开输入", async t => {
  const filename = databasePath(t);
  const server = createLearningServer({
    databasePath: filename, publication: reading, sessions: new Map([["student", "reader"]]),
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/activities`, {
      method: "POST",
      headers: { cookie: "learning_session=student", "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, practiceId: reading.practice.id, operationId: "start" }),
    });
    assert.equal(response.status, 200);
    const { activityId } = z.object({ activityId: z.uuid() }).parse(await response.json());
    const active = await fetch(`http://127.0.0.1:${address.port}/api/activities/${activityId}`, {
      headers: { cookie: "learning_session=student" },
    });
    assert.equal(active.status, 200);
    const body = await active.text();
    assert.doesNotMatch(body, /"scoringKey"|"acceptedChoices"|"keyRef"|"questions"|"decide"/);
    assert.deepEqual(JSON.parse(body).inputs, {
      passage: { from: "material", positionId: "evidence-passage" },
    });
    using database = openDatabase(filename);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count, 1);
    assert.deepEqual(publicationCounts(database), [1, 1, 1]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function withSteps(...steps: unknown[]) {
  return { ...reading, practice: { ...reading.practice, steps } };
}

function withGrading(grading: unknown) {
  return { ...reading, practice: { ...reading.practice, grading } };
}

function publicationCounts(database: ReturnType<typeof openDatabase>) {
  return [
    database.prepare("SELECT COUNT(*) AS count FROM materials").get()?.count,
    database.prepare("SELECT COUNT(*) AS count FROM practices").get()?.count,
    database.prepare("SELECT COUNT(*) AS count FROM scoring_keys").get()?.count,
  ];
}
