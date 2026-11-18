import { clearLibraryActivity, renderLibraryActivity } from "/library-reading.mjs";

const element = id => document.getElementById(id);
const start = element("start");
const startButton = element("open-activity");
const workspace = element("workspace");
const title = element("title");
const progress = element("progress");
const paragraphs = element("paragraphs");
const preview = element("quote");
const emptyPreview = element("empty-preview");
const submitButton = element("submit-quote");
const submitError = element("submit-error");
const loadError = element("load-error");
const startKey = "learning-kernel:start";
let activity;
let pending;
let busy = false;

function api(path, input) {
  const request = input && {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, ...input }),
  };
  return fetch(path, { cache: "no-store", ...request }).then(async response => {
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error("请求未完成", { cause: response.status }), { code: payload.code });
    return payload;
  });
}

function activityURL(activityId) {
  return `/api/activities/${activityId}`;
}

function draftKey(activityId) {
  return `learning-kernel:draft:${activityId}`;
}

function storePending(next) {
  pending = next;
  sessionStorage.setItem(draftKey(activity.activityId), JSON.stringify(next));
}

function chooseRange(range) {
  if (selectionLocked() || !selectedText(range).trim()) return;
  storePending({ range, operationId: crypto.randomUUID() });
  submitError.hidden = true;
  showDraft();
}

function selectionLocked() {
  return busy || Boolean(pending?.draft);
}

function selectedText(range) {
  const paragraph = activity.material.paragraphs.find(item => item.id === range.paragraphId);
  return paragraph ? paragraph.text.slice(range.start, range.end) : "";
}

function renderQuote(text) {
  preview.textContent = text;
  const visible = text.length > 0;
  preview.hidden = !visible;
  emptyPreview.hidden = visible;
}

function showDraft() {
  renderQuote(pending ? selectedText(pending.range) : "");
  const retrying = Boolean(pending?.draft);
  const locked = selectionLocked();
  submitButton.disabled = busy || !pending;
  submitButton.textContent = busy ? "提交中…" : retrying ? "重试提交" : "提交引文";
  for (const choice of paragraphs.querySelectorAll("button")) {
    choice.disabled = locked;
  }
}

function showSubmission(submission) {
  renderQuote(submission.selection.text);
  element("preview-title").textContent = "已提交引文";
  element("receipt-id").textContent = submission.receipt.id;
  element("receipt").hidden = false;
  submitButton.hidden = true;
}

function showActivity(next) {
  if (next.formatVersion === 1) {
    start.hidden = true;
    loadError.hidden = true;
    title.textContent = next.title;
    progress.textContent = next.status === "completed" ? "活动已完成" : "进行中";
    const path = activityURL(next.activityId);
    renderLibraryActivity(next, api, () => api(path).then(showActivity), showLoadError);
    return;
  }
  activity = next;
  const complete = activity.status === "completed";
  start.hidden = true;
  loadError.hidden = true;
  submitError.hidden = true;
  title.textContent = activity.title;
  progress.textContent = complete ? "活动已完成" : "进行中";
  element("material-title").textContent = activity.material.title;
  element("instructions").textContent = activity.step.instructions;
  element("material-source").textContent = activity.material.source;
  const tool = activity.step.tool;
  const selectable = !complete && `${tool.id}@${tool.version}` === "text-selection@1";
  paragraphs.replaceChildren(...activity.material.paragraphs.map(paragraph => renderParagraph(paragraph, selectable)));
  if (activity.submission) {
    sessionStorage.removeItem(draftKey(activity.activityId));
    showSubmission(activity.submission);
  } else {
    pending = JSON.parse(sessionStorage.getItem(draftKey(activity.activityId)));
    showDraft();
  }
  workspace.hidden = false;
}

function renderParagraph(paragraph, selectable) {
  const row = document.createElement("div");
  row.className = "paragraph";
  const text = document.createElement("p");
  text.textContent = paragraph.text;
  row.append(text);
  if (selectable) {
    text.dataset.paragraph = paragraph.id;
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "choose";
    choice.textContent = "选用本段";
    choice.addEventListener("click", () => chooseRange({
      paragraphId: paragraph.id, start: 0, end: paragraph.text.length,
    }));
    row.append(choice);
  }
  return row;
}

function containingParagraph(node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element && element.closest("[data-paragraph]");
}

function textOffset(paragraph, node, offset) {
  const prefix = document.createRange();
  prefix.selectNodeContents(paragraph);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const paragraph = containingParagraph(range.startContainer);
  if (!paragraph || paragraph !== containingParagraph(range.endContainer)) return;
  chooseRange({
    paragraphId: paragraph.dataset.paragraph,
    start: textOffset(paragraph, range.startContainer, range.startOffset),
    end: textOffset(paragraph, range.endContainer, range.endOffset),
  });
});

async function openActivity() {
  startButton.disabled = true;
  try {
    const { practiceId } = await api("/demo/entry" + location.search);
    const practiceStart = location.search ? `${startKey}:${practiceId}` : startKey;
    const operationId = sessionStorage.getItem(practiceStart) || crypto.randomUUID();
    sessionStorage.setItem(practiceStart, operationId);
    const { activityId } = await api("/api/activities", { operationId, practiceId });
    const next = await api(activityURL(activityId));
    history.replaceState(null, "", `/activities/${activityId}`);
    showActivity(next);
  } catch (error) {
    showLoadError(error);
  } finally {
    startButton.disabled = false;
  }
}

function showLoadError(error) {
  if (error.cause === 401 || error.cause === 403) clearRestrictedActivity();
  if (error.cause === 403) {
    loadError.textContent = "当前账号无权查看此活动。";
  } else if (error.cause === 401) {
    const login = document.createElement("a");
    login.href = "/demo/student";
    login.textContent = "进入演示学生会话";
    loadError.replaceChildren("会话已结束。", login);
  } else {
    loadError.textContent = "无法打开活动，请刷新或重试。";
  }
  loadError.hidden = false;
}

function clearRestrictedActivity() {
  const activityId = activityIdFromPath();
  if (activityId) {
    sessionStorage.removeItem(draftKey(activityId));
    clearLibraryActivity(activityId);
  }
  activity = undefined;
  pending = undefined;
  workspace.hidden = true;
  paragraphs.replaceChildren();
  renderQuote("");
  for (const id of ["material-title", "instructions", "material-source", "receipt-id"]) {
    element(id).textContent = "";
  }
  element("receipt").hidden = true;
  title.textContent = "阅读练习";
  progress.textContent = "";
}

function activityIdFromPath() {
  return location.pathname.match(/^\/activities\/([a-f0-9-]{36})$/)?.[1];
}

startButton.addEventListener("click", openActivity);

submitButton.addEventListener("click", async () => {
  if (!pending || busy) return;
  busy = true;
  submitError.hidden = true;
  showDraft();
  const path = activityURL(activity.activityId);
  try {
    if (!pending.draft) {
      const { draft } = await api(path + "/drafts", { range: pending.range });
      storePending({ ...pending, draft });
    }
    await api(path + "/submissions", {
      operationId: pending.operationId,
      stepAttemptId: activity.stepAttemptId,
      slotId: activity.step.slotId,
      draft: pending.draft,
    });
    showActivity(await api(path));
  } catch (error) {
    if (error.cause === 401 || error.cause === 403) {
      showLoadError(error);
    } else {
      submitError.textContent = "未收到确认。可以用同一选区重试。";
      submitError.hidden = false;
    }
  } finally {
    busy = false;
    if (activity?.status === "active") showDraft();
  }
});

function readCurrentActivity() {
  start.hidden = true;
  progress.textContent = "正在读取活动…";
  api("/api" + location.pathname).then(showActivity, error => {
    progress.textContent = "";
    showLoadError(error);
  });
}

if (activityIdFromPath()) readCurrentActivity();

window.addEventListener("pageshow", event => {
  if (!event.persisted || !activityIdFromPath()) return;
  workspace.hidden = true;
  element("library-workspace").hidden = true;
  title.textContent = "阅读练习";
  readCurrentActivity();
});
