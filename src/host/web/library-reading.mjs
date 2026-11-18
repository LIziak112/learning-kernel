const root = document.getElementById("library-workspace");

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function button(label, action) {
  const node = text("button", label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

export function renderLibraryActivity(activity, api, refresh, reportError) {
  const article = document.createElement("article");
  article.className = "panel material";
  article.append(text("h2", activity.material.title), text("p", activity.step.instructions));
  const side = document.createElement("section");
  side.className = "panel quote-panel";
  const [slotId, slot] = Object.entries(activity.step.submit.slots).find(([, entry]) => entry.type !== "reuse");
  const sources = Object.values(activity.inputs);
  const completed = activity.status === "completed";
  const storageKey = `learning-kernel:library:${activity.stepAttemptId}`;
  const preview = document.createElement("div");
  const handleError = problem => {
    if (permissionDenied(problem)) clearLibraryActivity(storageKey);
    reportError(problem);
  };
  const pending = loadPending(storageKey, completed);
  const editor = slot.type === "passageSelection"
    ? selectionEditor(activity, slot, pending, article, preview, completed)
    : answerEditor(activity, sources, pending, article, preview);
  side.append(text("h2", editor.title), preview);
  if (completed) {
    const selection = activity.submission?.selection;
    if (selection) renderQuotes(preview, selection.ranges);
    side.append(readingResult(activity, refresh, handleError));
  } else {
    attachSubmission({ activity, api, refresh, handleError, slotId, storageKey, pending, editor, side });
  }
  root.replaceChildren(article, side);
  root.hidden = false;
}

function attachSubmission({ activity, api, refresh, handleError, slotId, storageKey, pending, editor, side }) {
  const error = text("p", "");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const confirm = button(editor.submitLabel, submit);
  let busy = false;
  editor.onChange(() => {
    pending = undefined;
    sessionStorage.removeItem(storageKey);
    error.hidden = true;
    update();
  });
  side.append(error, confirm);
  update();

  function update() {
    editor.lock(busy || Boolean(pending?.draft));
    confirm.disabled = busy || !editor.ready();
  }

  async function submit() {
    busy = true;
    error.hidden = true;
    update();
    const path = `/api/activities/${activity.activityId}`;
    const binding = { stepAttemptId: activity.stepAttemptId, slotId };
    try {
      pending ??= { payload: editor.payload(), operationId: crypto.randomUUID() };
      await submitReading(api, path, binding, pending, storageKey);
      sessionStorage.removeItem(storageKey);
      await refresh();
    } catch (problem) {
      if (permissionDenied(problem)) return handleError(problem);
      if (problem.cause === 422) {
        pending = undefined;
        sessionStorage.removeItem(storageKey);
      }
      error.textContent = "提交未确认，请检查选段或作答后重试。";
      error.hidden = false;
    } finally {
      busy = false;
      update();
    }
  }
}

function permissionDenied(problem) {
  return problem.cause === 401 || problem.cause === 403;
}

function clearLibraryActivity(storageKey) {
  root.hidden = true;
  root.replaceChildren();
  sessionStorage.removeItem(storageKey);
}

function loadPending(storageKey, completed) {
  if (completed) {
    sessionStorage.removeItem(storageKey);
    return null;
  }
  return JSON.parse(sessionStorage.getItem(storageKey));
}

function choiceEditor(values, required, completed) {
  const controls = [];
  let onChange;
  return {
    controls, values,
    ready: () => required.every(id => Object.hasOwn(values, id)),
    lock: locked => { for (const control of controls) control.disabled = locked; },
    change: (id, value) => {
      values[id] = value;
      onChange();
    },
    onChange: callback => { onChange = callback; },
    completed,
  };
}

function selectionEditor(activity, slot, pending, article, preview, completed) {
  const labels = slot.oneRangePerRole;
  const ranges = pending?.payload.ranges ?? [];
  const editor = choiceEditor(Object.fromEntries(ranges.map(range => [range.role, range])), Object.keys(labels), completed);
  article.append(...activity.material.paragraphs.map(paragraph => paragraphRow(paragraph, labels, editor)));
  const renderPreview = () => renderSelectionPreview(preview, activity.material.paragraphs, labels, editor.values);
  if (!completed) renderPreview();
  return {
    ...editor,
    title: completed ? "已交引文" : "引文预览",
    submitLabel: "提交选据",
    onChange: callback => editor.onChange(() => {
      renderPreview();
      callback();
    }),
    payload: () => ({ ranges: Object.values(editor.values) }),
  };
}

function renderSelectionPreview(preview, paragraphs, labels, values) {
  preview.replaceChildren(...Object.entries(labels).map(([role, label]) => {
    const paragraph = paragraphs.find(item => item.id === values[role]?.paragraphId);
    return text("p", `${label}　${paragraph?.text ?? "待选"}`);
  }));
}

function answerEditor(activity, sources, pending, article, preview) {
  const questions = sources.find(input => input.from === "questions")?.questions ?? [];
  const values = { ...(activity.submission?.answer?.choices ?? pending?.payload.choices) };
  const editor = choiceEditor(values, questions.map(question => question.id), activity.status === "completed");
  article.append(...activity.material.paragraphs.map(paragraph => paragraphRow(paragraph, {}, editor)));
  article.append(...questions.map(question => questionRow(question, editor)));
  const quotes = sources.filter(input => input.from === "submission").flatMap(input => input.selection?.ranges ?? []);
  renderQuotes(preview, quotes);
  editor.lock(editor.completed);
  return {
    ...editor,
    title: "已交引文",
    submitLabel: "交卷",
    payload: () => ({ choices: values, references: answerReferences(activity) }),
  };
}

function renderQuotes(preview, quotes) {
  preview.replaceChildren(...quotes.map(quote => text("blockquote", quote.text)));
}

function paragraphRow(paragraph, labels, editor) {
  const row = document.createElement("div");
  row.className = "paragraph";
  row.append(text("p", paragraph.text));
  if (editor.completed) return row;
  for (const [role, label] of Object.entries(labels)) {
    const action = button(`选为${label}`, () => editor.change(role, {
      role, paragraphId: paragraph.id, start: 0, end: paragraph.text.length,
    }));
    action.className = "choose";
    editor.controls.push(action);
    row.append(action);
  }
  return row;
}

function questionRow(question, editor) {
  const row = document.createElement("fieldset");
  row.className = "reading-question";
  row.append(text("legend", question.prompt));
  for (const [id, label] of Object.entries(question.options)) {
    const choice = document.createElement("input");
    choice.type = "radio";
    choice.name = question.id;
    choice.value = id;
    choice.checked = editor.values[question.id] === id;
    choice.addEventListener("change", () => editor.change(question.id, id));
    const option = document.createElement("label");
    option.append(choice, text("span", `${id} ${label}`));
    row.append(option);
    editor.controls.push(choice);
  }
  return row;
}

function answerReferences(activity) {
  return Object.fromEntries(Object.entries(activity.step.submit.slots)
    .filter(([, slot]) => slot.type === "reuse")
    .map(([name, slot]) => [name, activity.inputs[slot.source].receipt.id]));
}

async function submitReading(api, path, binding, pending, storageKey) {
  sessionStorage.setItem(storageKey, JSON.stringify(pending));
  if (!pending.draft) {
    const result = await api(path + "/drafts", { ...binding, ...pending.payload });
    pending.draft = result.draft;
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
  }
  return api(path + "/submissions", { ...binding, draft: pending.draft, operationId: pending.operationId });
}

function readingResult(activity, refresh, reportError) {
  const result = document.createElement("section");
  result.append(text("h2", "交卷结果"));
  if (activity.submission?.receipt) result.append(text("p", `提交回执 ${activity.submission.receipt.id}`));
  const assessment = activity.assessment;
  if (assessment?.status === "pending") {
    result.append(text("p", "已交，待评"), button("刷新成绩", () => refresh().catch(reportError)));
  } else if (assessment?.status === "complete") {
    result.append(text("p", scoreText(assessment)));
  }
  return result;
}

function scoreText({ correctCount, questionCount }) {
  if (correctCount === undefined) return questionCount === undefined ? "评阅已完成" : `共 ${questionCount} 题`;
  return questionCount === undefined ? `答对 ${correctCount} 题` : `${correctCount}/${questionCount}`;
}
