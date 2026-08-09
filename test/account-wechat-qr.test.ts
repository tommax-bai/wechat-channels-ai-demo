import { describe, expect, it } from "vitest";
import {
  MAX_ACCOUNT_WECHAT_QR_BYTES,
  parseAccountWechatQrDataUrl,
  parseStoredAccountWechatQr,
  storedAccountWechatQr,
} from "../src/account-wechat-qr.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("account WeChat QR data URL", () => {
  it.each([
    ["image/png" as const, PNG_BYTES],
    ["image/jpeg" as const, JPEG_BYTES],
  ])("accepts canonical bounded %s bytes", (mimeType, bytes) => {
    const dataUrl = toDataUrl(mimeType, bytes);
    const parsed = parseAccountWechatQrDataUrl(dataUrl);

    expect(parsed).toMatchObject({
      mimeType,
      dataBase64: bytes.toString("base64"),
      dataUrl,
    });
    expect(Buffer.from(parsed.bytes)).toEqual(bytes);
    expect(parseStoredAccountWechatQr(storedAccountWechatQr(parsed)).dataUrl)
      .toBe(dataUrl);
  });

  it("accepts exactly 512 KiB and rejects a larger image", () => {
    const maximum = Buffer.alloc(MAX_ACCOUNT_WECHAT_QR_BYTES);
    PNG_BYTES.copy(maximum);
    expect(parseAccountWechatQrDataUrl(toDataUrl("image/png", maximum)).bytes)
      .toHaveLength(MAX_ACCOUNT_WECHAT_QR_BYTES);

    const oversized = Buffer.alloc(MAX_ACCOUNT_WECHAT_QR_BYTES + 1);
    PNG_BYTES.copy(oversized);
    expect(() => parseAccountWechatQrDataUrl(toDataUrl("image/png", oversized)))
      .toThrow("account_wechat_qr_too_large");
  });

  it.each([
    ["empty", "data:image/png;base64,"],
    ["unsupported MIME", `data:image/gif;base64,${PNG_BYTES.toString("base64")}`],
    ["MIME and magic mismatch", toDataUrl("image/jpeg", PNG_BYTES)],
    ["malformed Base64", "data:image/png;base64,not*base64"],
    ["non-canonical Base64", `data:image/jpeg;base64,${JPEG_BYTES.toString("base64").replace(/=+$/, "")}`],
    ["whitespace", `data:image/png;base64,${PNG_BYTES.toString("base64")}\n`],
  ])("rejects %s input", (_label, dataUrl) => {
    expect(() => parseAccountWechatQrDataUrl(dataUrl))
      .toThrow("account_wechat_qr_invalid");
  });

  it("rejects a malformed encrypted value", () => {
    expect(() => parseStoredAccountWechatQr({
      version: 1,
      mimeType: "image/png",
      dataBase64: JPEG_BYTES.toString("base64"),
    })).toThrow("account_wechat_qr_invalid");
  });
});

function toDataUrl(mimeType: "image/png" | "image/jpeg", bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
