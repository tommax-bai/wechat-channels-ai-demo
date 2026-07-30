import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("public model copy", () => {
  it("uses the generic chat label without exposing the configured model identifier", () => {
    const publicSource = ["index.html", "app.js"]
      .map((file) => readFileSync(join(process.cwd(), "public", file), "utf8"))
      .join("\n");

    expect(publicSource).toContain("chat角色模型");
    expect(publicSource).toContain("chat-llm");
    expect(publicSource).toContain("CHAT回复");
    expect(publicSource).not.toContain("doubao-seed-character-260628");
    expect(publicSource).not.toContain("豆包");
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
});
