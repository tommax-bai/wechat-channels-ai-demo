import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

interface EnvelopeV1 {
  v: 1;
  alg: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecureStore {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("SecureStore requires a 32-byte key");
  }

  encryptJson(value: unknown, sessionId: string, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad(sessionId, purpose), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const envelope: EnvelopeV1 = {
      v: 1,
      alg: "A256GCM",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  decryptJson<T>(raw: string, sessionId: string, purpose: string): T {
    const envelope = parseEnvelope(raw);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad(sessionId, purpose), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  keyedHash(value: string, namespace: string): string {
    return createHmac("sha256", this.key)
      .update(namespace)
      .update("\0")
      .update(value)
      .digest("base64url");
  }
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function aad(sessionId: string, purpose: string): string {
  if (!sessionId || !purpose) throw new Error("encryption AAD scope is required");
  return `wechat-channels-ai-demo:v1:${sessionId}:${purpose}`;
}

function parseEnvelope(raw: string): EnvelopeV1 {
  const value = JSON.parse(raw) as Partial<EnvelopeV1>;
  if (
    value.v !== 1
    || value.alg !== "A256GCM"
    || typeof value.iv !== "string"
    || typeof value.tag !== "string"
    || typeof value.ciphertext !== "string"
  ) {
    throw new Error("unsupported encrypted envelope");
  }
  return value as EnvelopeV1;
}
