const root = document.getElementById("library-workspace");
const storagePrefix = "learning-kernel:library:";

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
  const storageKey = libraryStorageKey(activity);
  const preview = document.createElement("div");
  const pending = loadPending(storageKey, completed);
  const editor = slot.type === "passageSelection"
    ? selectionEditor(activity, slot, pending, article, preview, completed)
    : answerEditor(activity, sources, pending, article, preview);
  side.append(text("h2", editor.title), preview);
  if (completed) {
    const selection = activity.submission?.selection;
    if (selection) renderQuotes(preview, selection.ranges);
    const result = readingResult(activity, refresh, reportError);
    showUnsubmittedDraft(result, pending);
    side.append(result);
  } else {
    attachSubmission({ activity, api, refresh, handleError: reportError, slotId, storageKey, pending, editor, side });
  }
  root.replaceChildren(article, side);
  root.hidden = false;
}

function attachSubmission({ activity, api, refresh, handleError, slotId, storageKey, pending, editor, side }) {
  const expired = () => pending?.failure === "DEADLINE_PASSED";
  const error = submissionAlert(pending);
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
    confirm.disabled = busy || expired() || !editor.ready();
  }

  async function submit() {
    busy = true;
    error.hidden = true;
    update();
    const path = `/api/activities/${activity.activityId}`;
    const binding = { stepAttemptId: activity.stepAttemptId, slotId };
    try {
      pending ??= { payload: editor.payload(), operationId: crypto.randomUUID() };
      await confirmWithRefresh(api, path, binding, pending, storageKey, refresh);
    } catch (problem) {
      if (permissionDenied(problem)) return handleError(problem);
      if (problem.cause === 422) {
        pending = undefined;
        sessionStorage.removeItem(storageKey);
      }
      error.textContent = turnInMessage(problem.code);
      error.hidden = false;
    } finally {
      busy = false;
      update();
    }
  }
}

function submissionAlert(pending) {
  const error = text("p", turnInMessage(pending?.failure));
  error.setAttribute("role", "alert");
  error.hidden = pending?.failure !== "DEADLINE_PASSED";
  return error;
}

function permissionDenied(problem) {
  return problem.cause === 401 || problem.cause === 403;
}

export function clearLibraryActivity(activityId) {
  root.hidden = true;
  root.replaceChildren();
  const scoped = `${storagePrefix}${activityId}:`;
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(scoped) || (key.startsWith(storagePrefix) && !key.slice(storagePrefix.length).includes(":"))) {
      sessionStorage.removeItem(key);
    }
  }
}

function libraryStorageKey({ activityId, stepAttemptId }) {
  const key = `${storagePrefix}${activityId}:${stepAttemptId}`;
  const legacy = storagePrefix + stepAttemptId;
  const stored = sessionStorage.getItem(legacy);
  if (stored && !sessionStorage.getItem(key)) sessionStorage.setItem(key, stored);
  sessionStorage.removeItem(legacy);
  return key;
}

function loadPending(storageKey, completed) {
  const pending = JSON.parse(sessionStorage.getItem(storageKey));
  if (completed && pending?.failure !== "ALREADY_SUBMITTED") {
    sessionStorage.removeItem(storageKey);
    return null;
  }
  return pending;
}

function showUnsubmittedDraft(result, pending) {
  if (!pending) return;
  const choices = Object.values(pending.payload.choices ?? {});
  result.append(text("h3", "本窗口未交出的草稿"));
  if (choices.length) result.append(text("p", choices.join("、")));
}

function turnInMessage(code) {
  return code === "DEADLINE_PASSED"
    ? "已到截止，草稿已保留。"
    : "提交未确认，请检查选段或作答后重试。";
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
  const publishedVerdicts = reviewVerdicts(activity.review);
  article.append(...questions.map(question => questionRow(question, editor, publishedVerdicts.get(question.id))));
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

function reviewVerdicts(review) {
  return new Map((review?.byQuestion ?? []).map(item => [item.questionId, item.correct]));
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

function questionRow(question, editor, verdict) {
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
  if (verdict !== undefined) row.append(text("p", verdict ? "判定正确" : "判定错误"));
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

async function confirmWithRefresh(api, path, binding, pending, storageKey, refresh) {
  try {
    await submitReading(api, path, binding, pending, storageKey);
    sessionStorage.removeItem(storageKey);
  } catch (problem) {
    if (problem.code === "DEADLINE_PASSED" || problem.code === "ALREADY_SUBMITTED") {
      pending.failure = problem.code;
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
    }
    if (problem.code !== "ALREADY_SUBMITTED") throw problem;
  }
  await refresh();
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
  const feedback = activity.review?.selectionFeedback;
  if (feedback) result.append(text("h3", "选据评语"), text("p", feedback));
  return result;
}

function scoreText({ correctCount, questionCount }) {
  if (correctCount === undefined) return questionCount === undefined ? "评阅已完成" : `共 ${questionCount} 题`;
  return questionCount === undefined ? `答对 ${correctCount} 题` : `${correctCount}/${questionCount}`;
}
