const elements = {
  authBadge: document.querySelector("#authBadge"),
  loginStage: document.querySelector("#loginStage"),
  verifiedIcon: document.querySelector("#verifiedIcon"),
  verifiedLabel: document.querySelector("#verifiedLabel"),
  accountName: document.querySelector("#accountName"),
  authHint: document.querySelector("#authHint"),
  refreshLoginButton: document.querySelector("#refreshLoginButton"),
  wechatQrStatus: document.querySelector("#wechatQrStatus"),
  wechatQrImage: document.querySelector("#wechatQrImage"),
  wechatQrEmpty: document.querySelector("#wechatQrEmpty"),
  wechatQrMeta: document.querySelector("#wechatQrMeta"),
  wechatQrFile: document.querySelector("#wechatQrFile"),
  wechatQrChoose: document.querySelector("#wechatQrChoose"),
  wechatQrDelete: document.querySelector("#wechatQrDelete"),
  wechatQrHint: document.querySelector("#wechatQrHint"),
};

const authLabels = {
  new: "正在准备",
  qr_pending: "等待扫码",
  scanned: "手机待确认",
  capturing_context: "正在初始化",
  authenticated: "身份已验证",
  baseline_sync: "正在建立连接",
  active: "自动回复运行中",
  expired: "二维码已过期",
  cancelled: "扫码已取消",
  no_account: "未选择视频号",
  auth_required: "需要重新登录",
  schema_changed: "接口发生变化",
  stopped: "自动回复已停止",
  logged_out: "已退出",
};

const errorLabels = {
  account_wechat_qr_invalid: "二维码文件无效，请选择 PNG 或 JPEG 图片",
  account_wechat_qr_too_large: "二维码文件不能超过 512 KiB",
  connect_account_required: "请先扫码登录视频号",
};

const MAX_QR_BYTES = 512 * 1024;
let current = null;
let refreshing = false;
let loginBusy = false;
let qrBusy = false;

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
  const body = response.status === 204
    ? null
    : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `http_${response.status}`);
  return body;
}

async function refresh() {
  if (refreshing || loginBusy || qrBusy) return;
  refreshing = true;
  try {
    current = await api("/api/connect");
    render(current);
  } catch (error) {
    elements.authHint.textContent = labelError(error.message);
  } finally {
    refreshing = false;
  }
}

function render(snapshot) {
  const bound = snapshot.accountBound;
  const connected = bound && Boolean(snapshot.accountDisplayName);
  elements.authBadge.textContent = authLabels[snapshot.authState] || "连接状态更新";
  elements.authBadge.classList.toggle(
    "warning",
    ["expired", "cancelled", "auth_required", "schema_changed"].includes(snapshot.authState),
  );
  elements.verifiedIcon.textContent = connected ? "✓" : "·";
  elements.verifiedIcon.classList.toggle("ok", connected);
  elements.verifiedLabel.textContent = connected ? "视频号身份已验证" : "等待视频号扫码";
  elements.accountName.textContent = snapshot.accountDisplayName || "尚未登录";
  elements.authHint.textContent = authHint(snapshot);
  elements.refreshLoginButton.disabled = loginBusy;
  renderLoginStage(snapshot);
  renderWechatQr(snapshot);
}

function renderLoginStage(snapshot) {
  if (snapshot.qrDataUrl) {
    elements.loginStage.innerHTML = "";
    const image = document.createElement("img");
    image.src = snapshot.qrDataUrl;
    image.alt = "视频号登录二维码";
    elements.loginStage.append(image);
    return;
  }
  const connected = snapshot.accountBound && snapshot.accountDisplayName;
  elements.loginStage.innerHTML = connected
    ? '<div class="qr-placeholder"><span class="check-large">✓</span><strong>连接已建立</strong></div>'
    : '<div class="qr-placeholder"><span class="spinner"></span><strong>正在获取二维码</strong></div>';
}

function authHint(snapshot) {
  if (snapshot.qrDataUrl) {
    if (snapshot.authState === "scanned") return "扫码已确认，请在手机上完成登录。";
    return "请使用微信扫描左侧二维码并在手机上确认。";
  }
  if (snapshot.accountBound && snapshot.authState === "active") {
    return "连接已建立，只会自动回复基线完成后新收到的文本内容。";
  }
  if (snapshot.accountBound && snapshot.authState === "stopped") {
    return "连接已建立，当前账号自动回复已停止。";
  }
  if (["auth_required", "schema_changed", "expired", "cancelled"].includes(snapshot.authState)) {
    return "当前登录需要更新，请刷新二维码重新扫码。";
  }
  return "正在确认视频号登录状态，请稍候。";
}

function renderWechatQr(snapshot) {
  const qr = snapshot.wechatQr;
  const enabled = snapshot.accountBound && !qrBusy;
  elements.wechatQrChoose.disabled = !enabled;
  elements.wechatQrDelete.disabled = !enabled || !qr?.configured;
  elements.wechatQrChoose.textContent = qr?.configured ? "替换二维码" : "上传二维码";
  elements.wechatQrStatus.textContent = snapshot.accountBound
    ? qr?.configured ? "已配置" : "尚未配置"
    : "等待登录";
  elements.wechatQrStatus.classList.toggle("muted", !qr?.configured);

  if (qr?.configured && qr.dataUrl) {
    elements.wechatQrImage.src = qr.dataUrl;
    elements.wechatQrImage.hidden = false;
    elements.wechatQrEmpty.hidden = true;
    elements.wechatQrMeta.textContent = formatQrMeta(qr);
    elements.wechatQrHint.textContent = "当前账号二维码已配置，可替换或删除";
    return;
  }
  elements.wechatQrImage.removeAttribute("src");
  elements.wechatQrImage.hidden = true;
  elements.wechatQrEmpty.hidden = false;
  elements.wechatQrMeta.textContent = snapshot.accountBound
    ? "未选择任何文件"
    : "登录视频号后可配置";
  elements.wechatQrHint.textContent = snapshot.accountBound
    ? "当前账号尚未配置业务微信二维码"
    : "等待当前账号登录";
}

async function refreshLogin() {
  if (loginBusy) return;
  loginBusy = true;
  elements.refreshLoginButton.disabled = true;
  elements.authHint.textContent = "正在刷新二维码…";
  try {
    current = await api("/api/connect/login", { method: "POST", body: "{}" });
    render(current);
  } catch (error) {
    elements.authHint.textContent = labelError(error.message);
  } finally {
    loginBusy = false;
    elements.refreshLoginButton.disabled = false;
  }
}

async function uploadWechatQr(file) {
  if (!file || qrBusy) return;
  let failure = null;
  try {
    validateQrFile(file);
    qrBusy = true;
    elements.wechatQrHint.textContent = "正在上传二维码…";
    const dataUrl = await readFileDataUrl(file);
    const result = await api("/api/connect/wechat-qr", {
      method: "PUT",
      body: JSON.stringify({ dataUrl }),
    });
    current = { ...current, wechatQr: result.wechatQr };
    render(current);
  } catch (error) {
    failure = labelError(error.message);
  } finally {
    qrBusy = false;
    elements.wechatQrFile.value = "";
    if (current) renderWechatQr(current);
    if (failure) elements.wechatQrHint.textContent = failure;
  }
}

async function deleteWechatQr() {
  if (qrBusy || !current?.wechatQr?.configured) return;
  let failure = null;
  qrBusy = true;
  elements.wechatQrHint.textContent = "正在删除二维码…";
  try {
    const result = await api("/api/connect/wechat-qr", { method: "DELETE" });
    current = { ...current, wechatQr: result.wechatQr };
    render(current);
  } catch (error) {
    failure = labelError(error.message);
  } finally {
    qrBusy = false;
    if (current) renderWechatQr(current);
    if (failure) elements.wechatQrHint.textContent = failure;
  }
}

function validateQrFile(file) {
  if (!file.size) throw new Error("二维码文件不能为空");
  if (!["image/png", "image/jpeg"].includes(file.type)) {
    throw new Error("仅支持 PNG 或 JPEG 图片");
  }
  if (file.size > MAX_QR_BYTES) throw new Error("二维码文件不能超过 512 KiB");
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("二维码文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function formatQrMeta(qr) {
  const type = qr.mimeType === "image/png" ? "PNG" : "JPEG";
  const size = `${Math.max(1, Math.round(qr.byteLength / 1024))} KiB`;
  const time = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(qr.updatedAt));
  return `${type} · ${size} · ${time}`;
}

function labelError(code) {
  return errorLabels[code] || code || "操作失败，请稍后重试";
}

elements.refreshLoginButton.addEventListener("click", refreshLogin);
elements.wechatQrChoose.addEventListener("click", () => elements.wechatQrFile.click());
elements.wechatQrFile.addEventListener("change", () => uploadWechatQr(elements.wechatQrFile.files?.[0]));
elements.wechatQrDelete.addEventListener("click", deleteWechatQr);

void refresh();
setInterval(() => void refresh(), 2_000);
