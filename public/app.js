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
  modelStatus: document.querySelector("#modelStatus"),
  dmHealth: document.querySelector("#dmHealth"),
  dmDot: document.querySelector("#dmDot"),
  commentHealth: document.querySelector("#commentHealth"),
  commentDot: document.querySelector("#commentDot"),
  timeline: document.querySelector("#timeline"),
  timelineCount: document.querySelector("#timelineCount"),
  sessionExpiry: document.querySelector("#sessionExpiry"),
};

const authLabels = {
  new: "准备连接",
  qr_pending: "等待扫码",
  scanned: "手机待确认",
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
};

let snapshot = null;
let refreshing = false;
let eventSource = null;
let autoStarted = false;
let logoutArmed = false;
let logoutTimer = null;

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
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await api("/api/session");
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
  eventSource = new EventSource("/api/events");
  const update = () => void refresh();
  for (const eventName of [
    "snapshot",
    "auth.updated",
    "connection.updated",
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
  elements.modelStatus.textContent = data.service.modelConfigured
    ? "模型凭证已配置"
    : "尚未配置 ARK_API_KEY，自动回复保持关闭";
  elements.automationBadge.textContent = data.automationEnabled ? "运行中" : "已停止";
  elements.automationBadge.className = `badge ${data.automationEnabled ? "" : "muted"}`;
  elements.automationButton.textContent = data.automationEnabled ? "停止自动回复" : "恢复自动回复";
  elements.automationButton.disabled =
    !["active", "stopped"].includes(data.authState)
    || !data.service.modelConfigured
    || !data.service.autoReplyEnabled;
  elements.logoutButton.disabled = data.authState === "new";
  elements.sessionExpiry.textContent = `会话到期：${formatTime(data.expiresAt)}`;
  renderQr(data);
  renderSources(data.sources);
  renderTimeline(data.timeline);
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
  title.textContent = "CHAT回复";
  const text = document.createElement("p");
  text.textContent = item.replyText || "正在生成…";
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
elements.logoutButton.addEventListener("click", () => void logout());
void refresh();
