import { api } from "/api.mjs";

const lookup = document.getElementById("review-lookup");
const input = document.getElementById("review-activity");
const workspace = document.getElementById("teacher-workspace");
const alert = document.getElementById("review-error");
let currentActivity;

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function activityKey(value) {
  if (/^[a-f0-9-]{36}$/.test(value)) return value;
  try {
    return new URL(value, location.origin).pathname.match(/^\/activities\/([a-f0-9-]{36})$/)?.[1];
  } catch {
    return undefined;
  }
}

function clearReview() {
  workspace.replaceChildren();
  workspace.hidden = true;
}

function showError(problem) {
  if (problem.cause === 403 || problem.cause === 401) {
    clearReview();
    alert.textContent = "当前会话无权查看此评阅。";
  } else if (problem.code === "VERDICT_CONFLICT") {
    alert.textContent = "评阅已更新，请重新打开活动后再提交。";
  } else {
    alert.textContent = "评阅请求未确认，请重试。";
  }
  alert.hidden = false;
}

function openReview(id) {
  currentActivity = id;
  clearReview();
  alert.hidden = true;
  if (!id) {
    alert.textContent = "请输入学生的活动链接或编号。";
    alert.hidden = false;
    return;
  }
  history.replaceState(null, "", "/review?activity=" + id);
  refreshReview(id).catch(problem => {
    if (currentActivity === id) showError(problem);
  });
}

lookup.addEventListener("submit", event => {
  event.preventDefault();
  openReview(activityKey(input.value.trim()));
});

async function refreshReview(id) {
  const [review, settings] = await Promise.all([api("/api/reviews/" + id), api("/api/manage/" + id)]);
  if (currentActivity !== id) return;
  const work = document.createElement("section");
  work.className = "panel teacher-stack";
  work.append(text("h2", "学生提交"), ...submissionCards(review.submissions));
  if (review.selectionFeedback) work.append(text("h3", "选据评语"), text("p", review.selectionFeedback));
  const evaluation = evaluationPanel(id, review.verdicts ?? [], settings);
  workspace.replaceChildren(work, ...evaluation);
  workspace.hidden = false;
}

function evaluationPanel(id, verdicts, settings) {
  const showToggle = settings.canToggleReview || settings.reviewOpen;
  if (!showToggle && !verdicts.length) return [];
  const evaluation = document.createElement("section");
  evaluation.className = "panel teacher-stack";
  evaluation.append(text("h2", "评阅"));
  if (showToggle) evaluation.append(reviewToggle(id, settings));
  const canRevise = settings.reviewerActions.includes("reviseQuestionVerdict");
  for (const verdict of verdicts) evaluation.append(verdictCard(id, verdict, canRevise));
  return [evaluation];
}

function submissionCards(submissions) {
  if (!submissions.length) return [text("p", "学生还没有提交。")];
  return submissions.map(({ receipt, selection, answer }) => {
    const card = document.createElement("article");
    card.className = "teacher-stack";
    card.append(text("h3", selection ? "已交选据" : "已交作答"));
    if (selection) card.append(...selection.ranges.map(range => text("blockquote", range.text)));
    if (answer) card.append(text("p", Object.values(answer.choices).join("、")));
    const reference = text("p", "提交回执 " + receipt.id);
    reference.className = "secondary";
    card.append(reference);
    return card;
  });
}

function reviewToggle(id, settings) {
  const section = document.createElement("div");
  const status = text("p", settings.reviewOpen ? "复盘已开放" : "复盘已关闭");
  status.setAttribute("role", "status");
  section.append(status);
  if (settings.canToggleReview) {
    const action = text("button", settings.reviewOpen ? "关闭复盘" : "开放复盘");
    action.type = "button";
    action.addEventListener("click", () => changeReview(id, "/api/manage/" + id, {
      action: settings.reviewOpen ? "closeReview" : "openReview",
    }, action));
    section.append(action);
  }
  return section;
}

function verdictCard(id, verdict, canRevise) {
  const card = document.createElement("article");
  card.className = "teacher-verdict";
  card.dataset.question = verdict.questionId;
  card.append(text("h3", verdict.prompt ?? verdict.questionId), text("p", `修订 ${verdict.revision}`));
  if (verdict.choice) card.append(text("p", "学生原答 " + verdict.choice));
  if (verdict.effective) card.append(text("p", verdict.effective.correct ? "当前判定为对" : "当前判定为错"));
  if (canRevise) card.append(verdictForm(id, verdict));
  if (verdict.history?.length) card.append(historyList(verdict.history));
  return card;
}

function historyList(history) {
  const details = document.createElement("details");
  const list = document.createElement("ol");
  for (const event of history) list.append(text("li", `修订 ${event.revision}　${event.reason}`));
  details.append(text("summary", "改判与撤销记录"), list);
  return details;
}

function verdictForm(id, verdict) {
  const form = document.createElement("form");
  const fieldset = document.createElement("fieldset");
  fieldset.className = "teacher-form";
  const label = text("label", "评阅理由");
  const reason = document.createElement("input");
  reason.required = true;
  reason.maxLength = 5000;
  reason.id = `review-reason-${verdict.submissionId}-${verdict.questionId}`;
  label.htmlFor = reason.id;
  const actions = document.createElement("div");
  actions.className = "teacher-actions";
  actions.append(verdictButton("判对", "correct"), verdictButton("判错", "incorrect"));
  if (verdict.effective?.source === "teacherReview") actions.append(verdictButton("撤销改判", "withdraw"));
  fieldset.append(label, reason, actions);
  form.append(fieldset);
  let operation;
  form.addEventListener("submit", event => {
    event.preventDefault();
    const command = reviewCommand(verdict, event.submitter?.value, reason.value.trim());
    const identity = JSON.stringify(command);
    if (operation?.identity !== identity) operation = { identity, id: crypto.randomUUID() };
    changeReview(id, `/api/reviews/${id}/verdicts`, { ...command, operationId: operation.id }, fieldset);
  });
  return form;
}

function verdictButton(label, value) {
  const node = text("button", label);
  node.type = "submit";
  node.value = value;
  return node;
}

function reviewCommand(verdict, action, reason) {
  const { submissionId, questionId, targetId, revision, effective } = verdict;
  const scope = { submissionId, questionId, targetId, expectedRevision: revision, reason };
  return action === "withdraw"
    ? { ...scope, action, withdrawId: effective.id }
    : { ...scope, action: "override", correct: action !== "incorrect" };
}

async function changeReview(id, path, command, control) {
  control.disabled = true;
  alert.hidden = true;
  try {
    await api(path, command);
    await refreshReview(id);
  } catch (problem) {
    if (currentActivity === id) showError(problem);
  } finally {
    control.disabled = false;
  }
}

const requested = new URL(location.href).searchParams.get("activity");
if (requested) {
  input.value = requested;
  openReview(activityKey(requested));
}

window.addEventListener("pageshow", event => {
  if (event.persisted && currentActivity) openReview(currentActivity);
});
