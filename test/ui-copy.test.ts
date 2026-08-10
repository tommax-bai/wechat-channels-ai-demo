import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("public reply-provider copy", () => {
  it("shows provider choices without exposing model or upstream details", () => {
    const indexSource = readFileSync(
      join(process.cwd(), "public", "index.html"),
      "utf8",
    );
    const appSource = readFileSync(
      join(process.cwd(), "public", "app.js"),
      "utf8",
    );
    const publicSource = `${indexSource}\n${appSource}`;

    expect(indexSource).toContain("CHAT回复");
    expect(indexSource).toContain("招聘接口");
    expect(indexSource).toContain("招聘岗位号");
    expect(indexSource).not.toContain("chat-llm");
    expect(publicSource).not.toContain("doubao-seed-character-260628");
    expect(publicSource).not.toContain("豆包");
    expect(publicSource).not.toContain("ARK");
    expect(publicSource).not.toContain("115.190.239.42");
    expect(publicSource).not.toContain("/job/comment-reply/");
    expect(publicSource).not.toContain("/agent/b2c/chat");
  });

  it("saves account provider settings and gates automation on the selected provider", () => {
    const appSource = readFileSync(
      join(process.cwd(), "public", "app.js"),
      "utf8",
    );

    expect(appSource).toContain('api("/api/session/reply-provider"');
    expect(appSource).toContain("provider,");
    expect(appSource).toContain("jobNumber:");
    expect(appSource).toContain("data.replyProvider");
    expect(appSource).toContain("data.funnelJobNumber");
    expect(appSource).toContain("data.service.selectedProviderConfigured");
    expect(appSource).toContain('skipped: "无需回复"');
    expect(appSource).toContain('item.replyState === "skipped"');
    expect(appSource).toContain('item.replyAction === "send_wechat_qr"');
    expect(appSource).toContain('confirmed: "业务微信二维码已发送"');
    expect(appSource).toContain(': "暂无文字回复"');
  });

  it("keeps provider controls bound to one account during session transitions", () => {
    const appSource = readFileSync(
      join(process.cwd(), "public", "app.js"),
      "utf8",
    );

    expect(appSource).toContain("let sessionTransitioning = false");
    expect(appSource).toContain("const generation = ++sessionGeneration");
    expect(appSource.match(/if \(sessionTransitioning\) return;/g)).toHaveLength(2);
    expect(appSource).toContain("if (refreshing || sessionTransitioning) return");
    expect(appSource).toContain(
      "if (!snapshot || providerSaving || sessionTransitioning) return",
    );
    expect(appSource).toContain("const controlsDisabled = providerSaving || sessionTransitioning");
    expect(appSource).toContain("if (generation !== sessionGeneration) return");
    expect(appSource).toContain("formSessionId !== sharedSessions.selectedSessionId");
    expect(appSource).toContain("if (generation === sessionGeneration)");
    expect(appSource).toContain("else void refresh()");
  });

  it("manages one bounded business WeChat QR for the selected account", () => {
    const indexSource = readFileSync(
      join(process.cwd(), "public", "index.html"),
      "utf8",
    );
    const appSource = readFileSync(
      join(process.cwd(), "public", "app.js"),
      "utf8",
    );

    expect(indexSource).toContain("业务微信二维码");
    expect(indexSource).toContain('id="wechatQrPreview"');
    expect(indexSource).toContain('id="wechatQrFileInput"');
    expect(indexSource).toContain('accept="image/png,image/jpeg"');
    expect(indexSource).toContain('id="wechatQrDeleteButton"');
    expect(appSource).toContain("const WECHAT_QR_MAX_BYTES = 512 * 1024");
    expect(appSource).toContain("PNG_SIGNATURE");
    expect(appSource).toContain("JPEG_SIGNATURE");
    expect(appSource).toContain("account_wechat_qr_not_configured");
    expect(appSource).toContain('"/api/session/wechat-qr"');
    expect(appSource).toContain('"X-Demo-Account-Id": accountKey');
    expect(appSource).toContain("assertWechatQrResponseAccount(payload, accountKey)");
    expect(appSource).toContain('method: "PUT"');
    expect(appSource).toContain('method: "DELETE"');
    expect(appSource).toContain("resetWechatQrState()");
    expect(appSource).toContain("generation === sessionGeneration");
    expect(appSource).toContain("accountKey === currentWechatQrAccountKey()");
  });

  it("keeps SSE on compatible origins and uses five-second polling for Quick Tunnel", () => {
    const appSource = readFileSync(
      join(process.cwd(), "public", "app.js"),
      "utf8",
    );

    expect(appSource).toContain('new EventSource("/api/events")');
    expect(appSource).toContain(
      'window.location.hostname.endsWith(".trycloudflare.com")',
    );
    expect(appSource).toContain(
      "window.setInterval(() => void refresh(), 5_000)",
    );
  });

  it("describes platform-authoritative login state without an eight-hour expiry", () => {
    const publicSource = ["index.html", "app.js"]
      .map((file) => readFileSync(join(process.cwd(), "public", file), "utf8"))
      .join("\n");

    expect(publicSource).toContain("登录态：由视频号平台维持");
    expect(publicSource).not.toContain("会话到期");
    expect(publicSource).not.toContain("session.expiresAt");
    expect(publicSource).not.toContain("data.expiresAt");
  });
});

describe("focused connect page copy", () => {
  it("contains only login and current-account business QR controls", () => {
    const html = readFileSync(
      join(process.cwd(), "public", "connect.html"),
      "utf8",
    );
    const script = readFileSync(
      join(process.cwd(), "public", "connect.js"),
      "utf8",
    );
    const publicSource = `${html}\n${script}`;

    expect(html).toContain("01 · CONNECT");
    expect(html).toContain("扫码登录");
    expect(publicSource).toContain("视频号身份已验证");
    expect(html).toContain("刷新二维码");
    expect(html).toContain("当前账号");
    expect(html).toContain("业务微信二维码");
    expect(publicSource).toContain("替换二维码");
    expect(html).toContain("删除二维码");
    expect(html).not.toContain("会话切换");
    expect(html).not.toContain("回复模型");
    expect(html).not.toContain("招聘岗位号");
    expect(html).not.toContain("消息与回复");
    expect(html).not.toContain("停止自动回复");
    expect(script).toContain('api("/api/connect")');
    expect(script).toContain('api("/api/connect/login"');
    expect(script).toContain('api("/api/connect/wechat-qr"');
    expect(publicSource).not.toContain("doubao-seed-character-260628");
  });
});
