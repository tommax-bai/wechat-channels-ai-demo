const elements = {
  connectionDot: document.querySelector("#connectionDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  authBadge: document.querySelector("#authBadge"),
  qrStage: document.querySelector("#qrStage"),
  accountName: document.querySelector("#accountName"),
  authHint: document.querySelector("#authHint"),
  loginButton: document.querySelector("#loginButton"),
  automationBadge: document.querySelector("#automationBadge"),
  automationButton: document.querySelector("#automationButton"),
  logoutButton: document.querySelector("#logoutButton"),
  providerLabel: document.querySelector("#providerLabel"),
  modelStatus: document.querySelector("#modelStatus"),
  chatProviderInput: document.querySelector("#chatProviderInput"),
  funnelProviderInput: document.querySelector("#funnelProviderInput"),
  funnelProviderStatus: document.querySelector("#funnelProviderStatus"),
  funnelJobNumberInput: document.querySelector("#funnelJobNumberInput"),
  providerHint: document.querySelector("#providerHint"),
  saveReplyProviderButton: document.querySelector("#saveReplyProviderButton"),
  dmHealth: document.querySelector("#dmHealth"),
  dmDot: document.querySelector("#dmDot"),
  commentHealth: document.querySelector("#commentHealth"),
  commentDot: document.querySelector("#commentDot"),
  timeline: document.querySelector("#timeline"),
  timelineCount: document.querySelector("#timelineCount"),
  sessionExpiry: document.querySelector("#sessionExpiry"),
  currentSessionTab: document.querySelector("#currentSessionTab"),
  sessionSwitcherTab: document.querySelector("#sessionSwitcherTab"),
  sharedSessionCount: document.querySelector("#sharedSessionCount"),
  currentSessionView: document.querySelector("#currentSessionView"),
  sessionSwitcher: document.querySelector("#sessionSwitcher"),
  sessionList: document.querySelector("#sessionList"),
  addSessionButton: document.querySelector("#addSessionButton"),
};

const authLabels = {
  new: "准备连接",
  qr_pending: "等待扫码",
  scanned: "手机待确认",
  capturing_context: "正在初始化评论",
  authenticated: "身份已验证",
  baseline_sync: "建立历史基线",
  active: "自动回复运行中",
  expired: "二维码已过期",
  cancelled: "扫码已取消",
  no_account: "未选择视频号",
  auth_required: "需要重新登录",
  schema_changed: "接口发生变化",
  stopped: "自动回复已停止",
  logged_out: "已退出",
};

const sourceLabels = {
  pending: "等待建立历史基线",
  healthy: "同步正常",
  auth_required: "登录已失效",
  schema_changed: "接口结构发生变化",
  error: "本次同步失败",
};

const errorLabels = {
  platform_send_in_flight: "发送结果正在确认，请稍后再试",
  funnel_provider_unavailable: "招聘接口未配置",
  funnel_job_number_required: "请填写招聘岗位号",
};

const authErrorLabels = {
  browser_capture_unavailable: "登录初始化服务暂不可用，请稍后刷新二维码重试。",
  browser_capture_timeout: "登录初始化超时，请刷新二维码重新扫码。",
  browser_capture_identity_mismatch: "登录身份复核失败，请刷新二维码重新扫码。",
  browser_capture_failed: "登录初始化失败，请刷新二维码重新扫码。",
  browser_capture_cleanup_failed: "登录初始化未安全结束，请稍后重试。",
};

function authErrorLabel(code) {
  return authErrorLabels[code]
    || (typeof code === "string" && code.startsWith("browser_capture_")
      ? "登录初始化失败，请刷新二维码重新扫码。"
      : "登录授权需要更新，请刷新二维码重新扫码。");
}

let snapshot = null;
let refreshing = false;
let eventSource = null;
let autoStarted = false;
let logoutArmed = false;
let logoutTimer = null;
let sharedSessions = { selectedSessionId: null, sessions: [] };
let providerFormSessionId = null;
let providerFormDirty = false;
let providerSaving = false;
let sessionTransitioning = false;
let sessionGeneration = 0;

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `http_${response.status}`);
  return body;
}

async function refresh() {
  if (refreshing || sessionTransitioning) return;
  const generation = sessionGeneration;
  refreshing = true;
  try {
    const nextSharedSessions = await api("/api/sessions");
    if (generation !== sessionGeneration) return;
    if (nextSharedSessions.selectedSessionId === null && nextSharedSessions.sessions.length > 0) {
      sharedSessions = nextSharedSessions;
      renderSharedSessions(sharedSessions);
      snapshot = null;
      eventSource?.close();
      eventSource = null;
      elements.currentSessionTab.disabled = true;
      showView("sessions");
      return;
    }
    const nextSnapshot = await api("/api/session");
    if (generation !== sessionGeneration) return;
    sharedSessions = nextSharedSessions;
    snapshot = nextSnapshot;
    renderSharedSessions(sharedSessions);
    elements.currentSessionTab.disabled = false;
    render(snapshot);
    connectEvents();
    if (snapshot.authState === "new" && !autoStarted) {
      autoStarted = true;
      await startLogin();
    }
  } catch (error) {
    renderFatal(error.message);
  } finally {
    refreshing = false;
  }
}

async function selectSession(sessionId) {
  if (sessionTransitioning) return;
  const generation = ++sessionGeneration;
  let synchronized = false;
  eventSource?.close();
  eventSource = null;
  sessionTransitioning = true;
  setSessionButtonsDisabled(true);
  elements.addSessionButton.disabled = true;
  if (snapshot) updateProviderControls(snapshot, true);
  try {
    const nextSnapshot = await api("/api/sessions/select", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    const nextSharedSessions = await api("/api/sessions");
    if (generation !== sessionGeneration) return;
    snapshot = nextSnapshot;
    sharedSessions = nextSharedSessions;
    providerFormSessionId = nextSharedSessions.selectedSessionId || sessionId;
    providerFormDirty = false;
    autoStarted = true;
    elements.currentSessionTab.disabled = false;
    showView("current");
    renderSharedSessions(sharedSessions);
    render(snapshot);
    connectEvents();
    synchronized = true;
  } catch (error) {
    if (generation === sessionGeneration) renderFatal(error.message);
  } finally {
    if (generation === sessionGeneration) {
      sessionTransitioning = false;
      setSessionButtonsDisabled(false);
      elements.addSessionButton.disabled = false;
      if (synchronized && snapshot) updateProviderControls(snapshot, true);
      else void refresh();
    }
  }
}

async function addSession() {
  if (sessionTransitioning) return;
  const generation = ++sessionGeneration;
  let synchronized = false;
  eventSource?.close();
  eventSource = null;
  sessionTransitioning = true;
  setSessionButtonsDisabled(true);
  setBusy(elements.addSessionButton, true, "正在创建");
  if (snapshot) updateProviderControls(snapshot, true);
  try {
    const nextSnapshot = await api("/api/sessions/new", { method: "POST", body: "{}" });
    const nextSharedSessions = await api("/api/sessions");
    if (generation !== sessionGeneration) return;
    snapshot = nextSnapshot;
    sharedSessions = nextSharedSessions;
    providerFormSessionId = null;
    providerFormDirty = false;
    autoStarted = true;
    elements.currentSessionTab.disabled = false;
    showView("current");
    renderSharedSessions(sharedSessions);
    render(snapshot);
    connectEvents();
    await startLogin();
    synchronized = true;
  } catch (error) {
    if (generation === sessionGeneration) renderFatal(error.message);
  } finally {
    if (generation === sessionGeneration) {
      sessionTransitioning = false;
      setSessionButtonsDisabled(false);
      setBusy(elements.addSessionButton, false, "添加视频号");
      if (synchronized && snapshot) updateProviderControls(snapshot, true);
      else void refresh();
    }
  }
}

async function startLogin() {
  setBusy(elements.loginButton, true, "正在申请二维码");
  try {
    snapshot = await api("/api/session/login", { method: "POST", body: "{}" });
    render(snapshot);
  } catch (error) {
    elements.authHint.textContent = `二维码申请失败：${safeLabel(error.message)}`;
  } finally {
    setBusy(elements.loginButton, false, "刷新二维码");
  }
}

async function toggleAutomation() {
  if (!snapshot) return;
  setBusy(elements.automationButton, true, "正在更新");
  try {
    snapshot = await api("/api/session/automation", {
      method: "POST",
      body: JSON.stringify({ enabled: !snapshot.automationEnabled }),
    });
    render(snapshot);
  } finally {
    setBusy(elements.automationButton, false, "");
  }
}

async function saveReplyProvider() {
  if (!snapshot || providerSaving || sessionTransitioning) return;
  const generation = sessionGeneration;
  const formSessionId = providerFormSessionId;
  const provider = selectedProviderDraft();
  if (!provider) return;
  providerSaving = true;
  updateProviderControls(snapshot);
  elements.providerHint.textContent = "正在保存当前账号设置";
  try {
    const updatedSnapshot = await api("/api/session/reply-provider", {
      method: "POST",
      body: JSON.stringify({
        provider,
        jobNumber: elements.funnelJobNumberInput.value.trim(),
      }),
    });
    if (
      generation !== sessionGeneration
      || formSessionId !== sharedSessions.selectedSessionId
    ) return;
    snapshot = updatedSnapshot;
    providerFormDirty = false;
    render(snapshot);
  } catch (error) {
    elements.providerHint.textContent = safeLabel(error.message);
  } finally {
    providerSaving = false;
    if (snapshot) updateProviderControls(snapshot, true);
  }
}

async function logout() {
  if (!logoutArmed) {
    logoutArmed = true;
    elements.logoutButton.classList.add("armed");
    elements.logoutButton.textContent = "再次点击确认删除";
    logoutTimer = window.setTimeout(disarmLogout, 10_000);
    return;
  }
  disarmLogout();
  setBusy(elements.logoutButton, true, "正在删除");
  try {
    await api("/api/session", { method: "DELETE" });
    eventSource?.close();
    eventSource = null;
    autoStarted = false;
    snapshot = null;
    await refresh();
  } catch (error) {
    elements.authHint.textContent = `退出失败：${safeLabel(error.message)}`;
  } finally {
    setBusy(elements.logoutButton, false, "退出并删除数据");
  }
}

function disarmLogout() {
  logoutArmed = false;
  if (logoutTimer) window.clearTimeout(logoutTimer);
  logoutTimer = null;
  elements.logoutButton.classList.remove("armed");
  elements.logoutButton.textContent = "退出并删除数据";
}

function connectEvents() {
  if (eventSource || !snapshot) return;
  if (window.location.hostname.endsWith(".trycloudflare.com")) return;
  eventSource = new EventSource("/api/events");
  const update = () => void refresh();
  for (const eventName of [
    "snapshot",
    "auth.updated",
    "connection.updated",
    "settings.updated",
    "inbound.received",
    "reply.updated",
  ]) {
    eventSource.addEventListener(eventName, update);
  }
  eventSource.addEventListener("expired", () => {
    eventSource.close();
    eventSource = null;
    autoStarted = false;
    void refresh();
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    window.setTimeout(() => {
      if (snapshot) connectEvents();
    }, 2_000);
  };
}

function render(data) {
  const label = authLabels[data.authState] || data.authState;
  elements.connectionLabel.textContent = label;
  elements.authBadge.textContent = label;
  elements.authBadge.className = `badge ${badgeClass(data.authState)}`;
  elements.connectionDot.className = `status-dot ${dotClass(data.authState)}`;
  elements.accountName.textContent = data.accountDisplayName || "尚未连接";
  renderProviderSettings(data);
  elements.automationBadge.textContent = data.automationEnabled ? "运行中" : "已停止";
  elements.automationBadge.className = `badge ${data.automationEnabled ? "" : "muted"}`;
  elements.automationButton.textContent = data.automationEnabled ? "停止自动回复" : "恢复自动回复";
  elements.automationButton.disabled =
    !["active", "stopped"].includes(data.authState)
    || !data.service.selectedProviderConfigured
    || !data.service.autoReplyEnabled;
  elements.logoutButton.disabled = data.authState === "new";
  elements.sessionExpiry.textContent = "登录态：由视频号平台维持";
  renderQr(data);
  renderSources(data.sources);
  renderTimeline(data.timeline);
}

function renderProviderSettings(data) {
  const activeSessionId = sharedSessions.selectedSessionId;
  if (!providerFormDirty || providerFormSessionId !== activeSessionId) {
    providerFormSessionId = activeSessionId;
    providerFormDirty = false;
    elements.chatProviderInput.checked = data.replyProvider !== "funnel";
    elements.funnelProviderInput.checked = data.replyProvider === "funnel";
    elements.funnelJobNumberInput.value = data.funnelJobNumber || "";
  }
  elements.providerLabel.textContent = providerLabel(data.replyProvider);
  elements.modelStatus.textContent = data.service.selectedProviderConfigured
    ? "当前方式已配置"
    : "当前方式未配置";
  updateProviderControls(data);
}

function updateProviderControls(data, preserveHint = false) {
  const chatConfigured = data.service.chatReplyConfigured ?? data.service.modelConfigured ?? false;
  const funnelConfigured = Boolean(data.service.funnelReplyConfigured);
  const draftProvider = selectedProviderDraft();
  const jobNumber = elements.funnelJobNumberInput.value.trim();

  const controlsDisabled = providerSaving || sessionTransitioning;
  elements.chatProviderInput.disabled = !chatConfigured || controlsDisabled;
  elements.funnelProviderInput.disabled = !funnelConfigured || controlsDisabled;
  elements.funnelProviderStatus.textContent = funnelConfigured ? "服务已配置" : "接口未配置";
  elements.funnelJobNumberInput.disabled = draftProvider !== "funnel" || !funnelConfigured || controlsDisabled;
  elements.funnelJobNumberInput.setAttribute(
    "aria-invalid",
    String(draftProvider === "funnel" && !jobNumber),
  );

  const draftConfigured = draftProvider === "funnel" ? funnelConfigured : chatConfigured;
  const valid = Boolean(draftProvider)
    && draftConfigured
    && (draftProvider !== "funnel" || Boolean(jobNumber));
  elements.saveReplyProviderButton.disabled = controlsDisabled || !providerFormDirty || !valid;
  elements.saveReplyProviderButton.textContent = providerSaving ? "正在保存" : "保存回复方式";

  if (preserveHint) return;
  if (draftProvider === "funnel" && !funnelConfigured) {
    elements.providerHint.textContent = "招聘接口未配置";
  } else if (draftProvider === "funnel" && !jobNumber) {
    elements.providerHint.textContent = "请填写招聘岗位号";
  } else if (providerFormDirty) {
    elements.providerHint.textContent = `保存后，新回复将使用${providerLabel(draftProvider)}`;
  } else if (!data.service.selectedProviderConfigured) {
    elements.providerHint.textContent = "当前回复方式未配置，自动回复保持关闭";
  } else {
    elements.providerHint.textContent = `当前账号使用${providerLabel(data.replyProvider)}`;
  }
}

function selectedProviderDraft() {
  if (elements.funnelProviderInput.checked) return "funnel";
  if (elements.chatProviderInput.checked) return "chat-llm";
  return null;
}

function providerLabel(provider) {
  return provider === "funnel" ? "招聘接口" : "CHAT回复";
}

function renderSharedSessions(data) {
  elements.sharedSessionCount.textContent = String(data.sessions.length);
  elements.sessionList.replaceChildren();
  if (!data.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "还没有已登录视频号";
    const copy = document.createElement("p");
    copy.textContent = "点击“添加视频号”扫码登录。";
    empty.append(title, copy);
    elements.sessionList.append(empty);
    return;
  }
  for (const session of data.sessions) {
    const card = document.createElement("article");
    card.className = "session-card";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = session.accountDisplayName;
    const meta = document.createElement("small");
    meta.textContent = `${authLabels[session.authState] || session.authState} · 平台登录态`;
    info.append(name, meta);
    const button = document.createElement("button");
    const selected = session.sessionId === data.selectedSessionId;
    button.className = `button ${selected ? "ghost" : "secondary"}`;
    button.type = "button";
    button.disabled = selected;
    button.dataset.sessionId = session.sessionId;
    button.textContent = selected ? "当前账号" : "切换";
    button.addEventListener("click", () => void selectSession(session.sessionId));
    card.append(info, button);
    elements.sessionList.append(card);
  }
}

function showView(view) {
  if (view === "current" && !snapshot) return;
  const sessions = view === "sessions";
  elements.currentSessionView.hidden = sessions;
  elements.sessionSwitcher.hidden = !sessions;
  elements.currentSessionTab.classList.toggle("active", !sessions);
  elements.currentSessionTab.setAttribute("aria-selected", String(!sessions));
  elements.sessionSwitcherTab.classList.toggle("active", sessions);
  elements.sessionSwitcherTab.setAttribute("aria-selected", String(sessions));
  if (sessions) {
    const generation = sessionGeneration;
    void api("/api/sessions").then((data) => {
      if (generation !== sessionGeneration || sessionTransitioning) return;
      sharedSessions = data;
      renderSharedSessions(data);
    });
  }
}

function setSessionButtonsDisabled(disabled) {
  for (const button of elements.sessionList.querySelectorAll("button")) {
    button.disabled = disabled || button.textContent === "当前账号";
  }
}

function renderQr(data) {
  elements.qrStage.replaceChildren();
  if (data.qrDataUrl) {
    const image = document.createElement("img");
    image.src = data.qrDataUrl;
    image.alt = "视频号登录二维码";
    elements.qrStage.append(image);
    elements.authHint.textContent = `请使用微信扫码并确认。二维码到期：${formatTime(data.qrExpiresAt)}`;
    elements.loginButton.disabled = false;
    return;
  }
  const placeholder = document.createElement("div");
  placeholder.className = "qr-placeholder";
  const mark = document.createElement("span");
  mark.textContent = data.accountDisplayName ? "✓" : "✦";
  mark.style.fontSize = "36px";
  const text = document.createElement("span");
  text.textContent = data.accountDisplayName
    ? "视频号身份已验证"
    : data.authState === "expired"
      ? "二维码已过期，请刷新"
      : "正在等待可用二维码";
  placeholder.append(mark, text);
  elements.qrStage.append(placeholder);
  elements.authHint.textContent = data.authState === "baseline_sync"
    ? "正在读取历史私信和评论；基线完成前不会自动回复。"
    : data.authState === "active"
      ? "连接已建立，只会自动回复基线完成后新收到的文本内容。"
      : data.authState === "capturing_context"
        ? "扫码已确认，正在初始化评论连接，请稍候。"
      : data.authState === "auth_required"
        ? authErrorLabel(data.authErrorCode)
        : "如二维码失效，可重新申请。";
}

function renderSources(sources) {
  for (const source of sources) {
    const label = sourceLabels[source.state] || source.state;
    const target = source.source === "dm"
      ? { text: elements.dmHealth, dot: elements.dmDot }
      : { text: elements.commentHealth, dot: elements.commentDot };
    target.text.textContent = source.baselineComplete ? label : `${label} · 自动回复未开启`;
    target.dot.className = `mini-dot ${source.state === "healthy" ? "good" : source.state === "pending" ? "" : "bad"}`;
  }
}

function renderTimeline(items) {
  elements.timelineCount.textContent = `${items.length} 条`;
  elements.timeline.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const mark = document.createElement("span");
    mark.textContent = "✦";
    const title = document.createElement("strong");
    title.textContent = "暂时没有互动内容";
    const copy = document.createElement("p");
    copy.textContent = "登录后会先展示历史内容并建立基线；新私信或评论到达后，这里会实时显示模型生成和平台发送结果。";
    empty.append(mark, title, copy);
    elements.timeline.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "timeline-item";
    const channel = document.createElement("span");
    channel.className = "channel-chip";
    channel.textContent = item.source === "dm" ? "信" : "评";
    const body = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const author = document.createElement("strong");
    author.textContent = item.authorName;
    const kind = document.createElement("span");
    kind.textContent = item.historical ? "历史内容" : "新内容";
    const time = document.createElement("time");
    time.textContent = formatTime(item.occurredAt);
    meta.append(author, kind, time);
    const text = document.createElement("p");
    text.className = "item-text";
    text.textContent = item.text;
    body.append(meta, text);
    if (item.replyState) body.append(renderReply(item));
    card.append(channel, body);
    elements.timeline.append(card);
  }
}

function renderReply(item) {
  const box = document.createElement("div");
  box.className = "reply-box";
  const title = document.createElement("small");
  title.textContent = "自动回复";
  const text = document.createElement("p");
  text.textContent = item.replyState === "skipped"
    ? "无需回复"
    : item.replyText || "正在生成…";
  const state = document.createElement("span");
  state.className = `reply-state ${item.replyState}`;
  state.textContent = replyStateLabel(item.replyState, item.replyErrorCode);
  box.append(title, text, state);
  return box;
}

function replyStateLabel(state, error) {
  const labels = {
    queued: "等待生成",
    generating: "正在生成",
    generated: "准备发送",
    sending: "正在提交",
    confirmed: "平台已确认",
    skipped: "无需回复",
    failed: "处理失败",
    submitted_unknown: "已提交，结果未知",
  };
  return `${labels[state] || state}${error ? ` · ${safeLabel(error)}` : ""}`;
}

function badgeClass(state) {
  if (["expired", "cancelled", "no_account", "auth_required", "schema_changed"].includes(state)) return "bad";
  if (["qr_pending", "scanned", "baseline_sync"].includes(state)) return "warn";
  if (state === "stopped") return "muted";
  return "";
}

function dotClass(state) {
  if (["active", "authenticated"].includes(state)) return "good";
  if (["qr_pending", "scanned", "baseline_sync", "stopped"].includes(state)) return "warn";
  if (["expired", "cancelled", "no_account", "auth_required", "schema_changed"].includes(state)) return "bad";
  return "";
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = label;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function safeLabel(value) {
  const raw = String(value || "unknown_error");
  return errorLabels[raw] || raw.replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 80);
}

function renderFatal(code) {
  elements.connectionLabel.textContent = "服务不可用";
  elements.connectionDot.className = "status-dot bad";
  elements.authHint.textContent = `服务错误：${safeLabel(code)}`;
}

elements.loginButton.addEventListener("click", () => void startLogin());
elements.automationButton.addEventListener("click", () => void toggleAutomation());
elements.chatProviderInput.addEventListener("change", () => {
  providerFormDirty = true;
  if (snapshot) updateProviderControls(snapshot);
});
elements.funnelProviderInput.addEventListener("change", () => {
  providerFormDirty = true;
  if (snapshot) updateProviderControls(snapshot);
});
elements.funnelJobNumberInput.addEventListener("input", () => {
  providerFormDirty = true;
  if (snapshot) updateProviderControls(snapshot);
});
elements.saveReplyProviderButton.addEventListener("click", () => void saveReplyProvider());
elements.logoutButton.addEventListener("click", () => void logout());
elements.currentSessionTab.addEventListener("click", () => showView("current"));
elements.sessionSwitcherTab.addEventListener("click", () => showView("sessions"));
elements.addSessionButton.addEventListener("click", () => void addSession());
window.setInterval(() => void refresh(), 5_000);
void refresh();
