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
