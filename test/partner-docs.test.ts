import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const markdown = readFileSync(
  join(process.cwd(), "docs", "partner-api.md"),
  "utf8",
);
const openapi = readFileSync(
  join(process.cwd(), "docs", "partner-api.openapi.yaml"),
  "utf8",
);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return "";
  return source.slice(startIndex, endIndex);
}

describe("Partner business WeChat QR documentation", () => {
  it("documents the same metadata-only GET, PUT, and DELETE contract", () => {
    const markdownSection = section(
      markdown,
      "## 9. 业务微信二维码",
      "## 10. 评论和私信",
    );
    const pathSection = section(
      openapi,
      "  /accounts/{accountId}/wechat-qr:",
      "  /accounts/{accountId}/comments:",
    );

    expect(markdownSection).toContain("GET /accounts/{accountId}/wechat-qr");
    expect(markdownSection).toContain("PUT /accounts/{accountId}/wechat-qr");
    expect(markdownSection).toContain("DELETE /accounts/{accountId}/wechat-qr");
    expect(markdownSection).toContain("不回显 `dataUrl`");
    expect(pathSection).toContain("    get:");
    expect(pathSection).toContain("    put:");
    expect(pathSection).toContain("    delete:");
    expect(pathSection.match(/WechatQrSettingsResponse/g)).toHaveLength(3);
  });

  it("keeps account and settings projections free of business QR image bytes", () => {
    const accountSchema = section(
      openapi,
      "    AccountProjection:",
      "    LoginStatusResponse:",
    );
    const settingsSchema = section(
      openapi,
      "    WechatQrSettingsResponse:",
      "    WechatQrProjection:",
    );
    const projectionSchema = section(
      openapi,
      "    WechatQrProjection:",
      "    WechatQrUpdate:",
    );

    expect(accountSchema).toContain("        - wechatQr");
    expect(accountSchema).toContain("#/components/schemas/WechatQrProjection");
    expect(settingsSchema).not.toContain("dataUrl:");
    expect(projectionSchema).not.toContain("dataUrl:");
    expect(projectionSchema).not.toContain("base64:");
    expect(projectionSchema).toContain("maximum: 524288");
  });

  it("documents strict PNG/JPEG input and the decoded 512 KiB limit", () => {
    const updateSchema = section(
      openapi,
      "    WechatQrUpdate:",
      "    SourceProjections:",
    );

    expect(updateSchema).toContain("        - dataUrl");
    expect(updateSchema).toContain("data:image/(png|jpeg)");
    expect(updateSchema).toContain("524288 bytes");
    expect(markdown).toContain("PNG 或 JPEG data URL");
    expect(markdown).toContain("不得超过 512 KiB");
  });
});
