import type { AccountQrAsset } from "./types.js";

export const MAX_ACCOUNT_WECHAT_QR_BYTES = 512 * 1_024;

const MAX_ENCODED_BYTES = Math.ceil(MAX_ACCOUNT_WECHAT_QR_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;

export const MAX_ACCOUNT_WECHAT_QR_DATA_URL_LENGTH =
  "data:image/jpeg;base64,".length + MAX_ENCODED_BYTES;

export interface StoredAccountWechatQr {
  version: 1;
  mimeType: AccountQrAsset["mimeType"];
  dataBase64: string;
}

export interface ParsedAccountWechatQr extends AccountQrAsset {
  dataBase64: string;
  dataUrl: string;
}

export function parseAccountWechatQrDataUrl(value: string): ParsedAccountWechatQr {
  if (value.length > MAX_ACCOUNT_WECHAT_QR_DATA_URL_LENGTH) return tooLarge();
  const match = DATA_URL.exec(value);
  if (!match?.[1] || !match[2]) return invalid();
  if (match[2].length > MAX_ENCODED_BYTES) return tooLarge();
  if (match[2].length % 4 !== 0) return invalid();

  const mimeType = match[1] as AccountQrAsset["mimeType"];
  const bytes = Buffer.from(match[2], "base64");
  if (
    bytes.length === 0
    || bytes.toString("base64") !== match[2]
    || !matchesMagic(bytes, mimeType)
  ) return invalid();
  if (bytes.length > MAX_ACCOUNT_WECHAT_QR_BYTES) return tooLarge();

  return {
    mimeType,
    bytes,
    dataBase64: match[2],
    dataUrl: `data:${mimeType};base64,${match[2]}`,
  };
}

export function parseStoredAccountWechatQr(value: unknown): ParsedAccountWechatQr {
  if (!isRecord(value) || value.version !== 1) return invalid();
  if (
    value.mimeType !== "image/png"
    && value.mimeType !== "image/jpeg"
  ) return invalid();
  if (typeof value.dataBase64 !== "string") return invalid();
  return parseAccountWechatQrDataUrl(
    `data:${value.mimeType};base64,${value.dataBase64}`,
  );
}

export function storedAccountWechatQr(
  value: ParsedAccountWechatQr,
): StoredAccountWechatQr {
  return {
    version: 1,
    mimeType: value.mimeType,
    dataBase64: value.dataBase64,
  };
}

function matchesMagic(bytes: Uint8Array, mimeType: AccountQrAsset["mimeType"]): boolean {
  const signature = mimeType === "image/png" ? PNG_SIGNATURE : JPEG_SIGNATURE;
  return bytes.length >= signature.length
    && signature.every((byte, index) => bytes[index] === byte);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("account_wechat_qr_invalid");
}

function tooLarge(): never {
  throw new Error("account_wechat_qr_too_large");
}
