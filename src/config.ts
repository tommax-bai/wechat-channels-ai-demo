import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const booleanString = z
  .enum(["0", "1", "true", "false"])
  .transform((value) => value === "1" || value === "true");

const optionalUrlString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional(),
);

const optionalSecretString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(32).optional(),
);

const optionalOpsPasswordString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(8).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  PUBLIC_ORIGIN: z.string().url().optional(),
  DATABASE_PATH: z.string().default("./data/demo.sqlite"),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("wechat_demo_session"),
  SESSION_COOKIE_SECURE: booleanString.optional(),
  SESSION_COOKIE_MAX_AGE_SECONDS: z.coerce.number().int().min(3_600).default(365 * 24 * 60 * 60),
  SESSION_ENCRYPTION_KEY: z.string().min(1),
  PENDING_SESSION_TTL_MS: z.coerce.number().int().min(60_000).optional(),
  SESSION_TTL_MS: z.coerce.number().int().min(60_000).optional(),
  QR_TTL_MS: z.coerce.number().int().min(30_000).default(4 * 60 * 1_000),
  LOGIN_POLL_MS: z.coerce.number().int().min(500).default(2_000),
  SYNC_POLL_MS: z.coerce.number().int().min(2_000).default(30_000),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(1_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  CLEANUP_POLL_MS: z.coerce.number().int().min(5_000).default(60_000),
  MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(100),
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).default(2 * 1_024 * 1_024),
  WECHAT_BASE_URL: z.string().url().default("https://channels.weixin.qq.com"),
  WECHAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  WECHAT_BROWSER_EXECUTABLE_PATH: z.string().default(""),
  WECHAT_BROWSER_CAPTURE_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(45_000),
  WECHAT_BROWSER_HEADLESS: booleanString.default(true),
  DEMO_AUTO_REPLY_ENABLED: booleanString.default(true),
  ARK_API_KEY: z.string().default(""),
  ARK_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/v3"),
  ARK_MODEL: z.string().min(1).default("doubao-seed-character-260628"),
  ARK_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(45_000),
  FUNNEL_BASE_URL: optionalUrlString,
  FUNNEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(45_000),
  PARTNER_API_KEY: optionalSecretString,
  OPS_PASSWORD: optionalOpsPasswordString,
});

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicOrigin?: string;
  databasePath: string;
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  sessionCookieMaxAgeSeconds: number;
  encryptionKey: Buffer;
  pendingSessionTtlMs: number;
  qrTtlMs: number;
  loginPollMs: number;
  syncPollMs: number;
  workerPollMs: number;
  workerConcurrency: number;
  cleanupPollMs: number;
  maxActiveSessions: number;
  maxResponseBytes: number;
  wechatBaseUrl: string;
  wechatTimeoutMs: number;
  wechatBrowserExecutablePath: string;
  wechatBrowserCaptureTimeoutMs: number;
  wechatBrowserHeadless: boolean;
  autoReplyEnabled: boolean;
  arkApiKey: string;
  arkBaseUrl: string;
  arkModel: string;
  arkTimeoutMs: number;
  funnelBaseUrl?: string;
  funnelTimeoutMs: number;
  partnerApiKey?: string;
  opsPassword?: string;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const encryptionKey = decodeEncryptionKey(parsed.SESSION_ENCRYPTION_KEY);
  const databasePath = resolve(parsed.DATABASE_PATH);
  const sessionCookieSecure =
    parsed.SESSION_COOKIE_SECURE ?? parsed.NODE_ENV === "production";
  if (
    parsed.NODE_ENV === "production"
    && !sessionCookieSecure
    && !["127.0.0.1", "::1", "localhost"].includes(parsed.HOST)
  ) {
    throw new Error(
      "SESSION_COOKIE_SECURE=0 is allowed in production only on a loopback HOST",
    );
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    ...(parsed.PUBLIC_ORIGIN ? { publicOrigin: parsed.PUBLIC_ORIGIN } : {}),
    databasePath,
    sessionCookieName: parsed.SESSION_COOKIE_NAME,
    sessionCookieSecure,
    sessionCookieMaxAgeSeconds: parsed.SESSION_COOKIE_MAX_AGE_SECONDS,
    encryptionKey,
    pendingSessionTtlMs:
      parsed.PENDING_SESSION_TTL_MS
      ?? parsed.SESSION_TTL_MS
      ?? 24 * 60 * 60 * 1_000,
    qrTtlMs: parsed.QR_TTL_MS,
    loginPollMs: parsed.LOGIN_POLL_MS,
    syncPollMs: parsed.SYNC_POLL_MS,
    workerPollMs: parsed.WORKER_POLL_MS,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    cleanupPollMs: parsed.CLEANUP_POLL_MS,
    maxActiveSessions: parsed.MAX_ACTIVE_SESSIONS,
    maxResponseBytes: parsed.MAX_RESPONSE_BYTES,
    wechatBaseUrl: parsed.WECHAT_BASE_URL.replace(/\/+$/, ""),
    wechatTimeoutMs: parsed.WECHAT_TIMEOUT_MS,
    wechatBrowserExecutablePath: parsed.WECHAT_BROWSER_EXECUTABLE_PATH.trim(),
    wechatBrowserCaptureTimeoutMs: parsed.WECHAT_BROWSER_CAPTURE_TIMEOUT_MS,
    wechatBrowserHeadless: parsed.WECHAT_BROWSER_HEADLESS,
    autoReplyEnabled: parsed.DEMO_AUTO_REPLY_ENABLED,
    arkApiKey: parsed.ARK_API_KEY,
    arkBaseUrl: parsed.ARK_BASE_URL.replace(/\/+$/, ""),
    arkModel: parsed.ARK_MODEL,
    arkTimeoutMs: parsed.ARK_TIMEOUT_MS,
    ...(parsed.FUNNEL_BASE_URL
      ? { funnelBaseUrl: parsed.FUNNEL_BASE_URL.replace(/\/+$/, "") }
      : {}),
    funnelTimeoutMs: parsed.FUNNEL_TIMEOUT_MS,
    ...(parsed.PARTNER_API_KEY
      ? { partnerApiKey: parsed.PARTNER_API_KEY }
      : {}),
    ...(parsed.OPS_PASSWORD
      ? { opsPassword: parsed.OPS_PASSWORD }
      : {}),
  };
}

function decodeEncryptionKey(raw: string): Buffer {
  const candidates = [
    Buffer.from(raw, "base64"),
    /^[a-fA-F0-9]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.alloc(0),
  ];
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    throw new Error("SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex characters)");
  }
  return key;
}

export function safeStartupSummary(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    listen: `${config.host}:${config.port}`,
    databasePath: config.databasePath,
    publicOriginConfigured: Boolean(config.publicOrigin),
    secureSessionCookie: config.sessionCookieSecure,
    pendingSessionTtlMs: config.pendingSessionTtlMs,
    sessionCookieMaxAgeSeconds: config.sessionCookieMaxAgeSeconds,
    autoReplyEnabled: config.autoReplyEnabled,
    workerConcurrency: config.workerConcurrency,
    modelConfigured: Boolean(config.arkApiKey),
    chatReplyConfigured: Boolean(config.arkApiKey),
    funnelReplyConfigured: Boolean(config.funnelBaseUrl),
    partnerApiConfigured: Boolean(config.partnerApiKey),
    opsLoginConfigured: Boolean(config.opsPassword),
    wechatBaseHost: new URL(config.wechatBaseUrl).host,
    commentCaptureConfigured: Boolean(config.wechatBrowserExecutablePath),
    commentCaptureHeadless: config.wechatBrowserHeadless,
  };
}
