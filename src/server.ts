import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { registerPartnerApi } from "./partner-api.js";
import { DEFAULT_FUNNEL_JOB_NUMBER } from "./reply-defaults.js";
import {
  isSessionRetained,
  type DemoRepository,
  type SessionRow,
} from "./repository.js";
import {
  SessionLimitError,
  type SessionService,
} from "./service/session-service.js";
import type { ConnectSnapshot } from "./types.js";

export interface ServerDependencies {
  config: AppConfig;
  repository: DemoRepository;
  sessions: SessionService;
}

const automationBody = z.object({ enabled: z.boolean() }).strict();
const replyProviderBody = z.object({
  provider: z.enum(["chat-llm", "funnel"]),
  jobNumber: z.string().max(128).optional(),
}).strict();
const accountWechatQrBody = z.object({
  dataUrl: z.string().min(1),
}).strict();
const contactSettingsBody = z.object({
  wechatId: z.string().max(64).optional(),
  replyType: z.enum(["qr", "wechat_id"]),
}).strict();
const connectReplySettingsBody = z.object({
  jobNumber: z.string().trim().min(1).max(128),
}).strict();
const selectSessionBody = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const opsLoginBody = z.object({
  password: z.string().min(1).max(256),
}).strict();

export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.nodeEnv === "test" ? "silent" : "info",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "res.headers.set-cookie",
      ],
    },
    trustProxy: deps.config.nodeEnv === "production",
  });
  await app.register(cookie);
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), "../public"),
    prefix: "/",
    index: "index.html",
    cacheControl: false,
    wildcard: false,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (
      request.url.startsWith("/api/")
      || request.url.startsWith("/partner/v1")
      || request.url === "/"
      || request.url.startsWith("/connect")
      || request.url.endsWith(".js")
      || request.url.endsWith(".css")
    ) {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Content-Security-Policy", [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join("; "));
    }
    return payload;
  });

  // Ops password gate for the console. The customer-facing connect page and the
  // separately authenticated partner API stay outside it.
  app.addHook("onRequest", async (request) => {
    if (!deps.config.opsPassword) return;
    const path = request.url.split("?", 1)[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (path.startsWith("/api/connect")) return;
    if (path === "/api/ops/login") return;
    if (!hasOpsAccess(request, deps.config)) throw new Error("ops_auth_required");
  });

  app.post("/api/ops/login", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    if (deps.config.opsPassword) {
      const body = opsLoginBody.parse(request.body);
      if (!secretMatches(body.password, deps.config.opsPassword)) {
        throw new Error("ops_password_invalid");
      }
      reply.setCookie(
        opsCookieName(deps.config),
        opsAccessValue(deps.config),
        cookieOptions(deps.config),
      );
    }
    return reply.code(204).send();
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({
    status: "ready",
    modelConfigured: Boolean(deps.config.arkApiKey),
    chatReplyConfigured: Boolean(deps.config.arkApiKey),
    funnelReplyConfigured: Boolean(deps.config.funnelBaseUrl),
    partnerApiConfigured: Boolean(deps.config.partnerApiKey),
    autoReplyEnabled: deps.config.autoReplyEnabled,
    commentCaptureConfigured: Boolean(
      deps.config.wechatBrowserExecutablePath,
    ),
  }));

  app.get("/connect", async (_request, reply) => reply.sendFile("connect.html"));
  app.get("/connect/", async (_request, reply) => reply.sendFile("connect.html"));

  app.get("/api/connect", async (request, reply) => {
    const context = await ensureConnectContext(request, reply, deps);
    return connectSnapshot(context.session, context.accountBound, deps);
  });

  app.post("/api/connect/login", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const existing = resolveConnectContext(request, reply, deps);
    if (!existing) {
      const context = await createPendingConnectContext(reply, deps);
      return connectSnapshot(context.session, false, deps);
    }
    await deps.sessions.startLogin(existing.session);
    const current = deps.repository.getSession(existing.session.id) ?? existing.session;
    return connectSnapshot(current, existing.accountBound, deps);
  });

  app.post("/api/connect/reply-settings", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireConnectAccount(request, reply, deps);
    const body = connectReplySettingsBody.parse(request.body);
    const updated = deps.sessions.setReplyProvider(
      session,
      "funnel",
      body.jobNumber,
    );
    return connectSnapshot(updated, true, deps);
  });

  app.get("/api/connect/wechat-qr", async (request, reply) => {
    const session = requireConnectAccount(request, reply, deps);
    return { wechatQr: deps.sessions.getAccountWechatQr(session) };
  });

  app.put("/api/connect/wechat-qr", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireConnectAccount(request, reply, deps);
    const body = accountWechatQrBody.parse(request.body);
    return { wechatQr: deps.sessions.setAccountWechatQr(session, body.dataUrl) };
  });

  app.delete("/api/connect/wechat-qr", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireConnectAccount(request, reply, deps);
    return { wechatQr: deps.sessions.deleteAccountWechatQr(session) };
  });

  app.get("/api/session", async (request, reply) => {
    const session = requireSession(request, reply, deps);
    return deps.sessions.snapshot(session);
  });

  app.get("/api/sessions", async (request, reply) => {
    const sessions = deps.sessions.listSharedSessions();
    const selectedCookieName = selectedSessionCookieName(deps.config);
    const selectedId = request.cookies[selectedCookieName];
    const explicitlySelected = deps.sessions.resolveShared(selectedId);
    if (selectedId && !explicitlySelected) {
      reply.clearCookie(selectedCookieName, cookieOptions(deps.config));
    }
    const browserOwned = deps.sessions.resolve(
      request.cookies[deps.config.sessionCookieName],
    );
    const selected = explicitlySelected
      ?? (!selectedId
        && browserOwned
        && sessions.some((session) => session.sessionId === browserOwned.id)
        ? browserOwned
        : null);
    return {
      selectedSessionId: selected?.id ?? null,
      sessions,
    };
  });

  app.post("/api/sessions/select", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const body = selectSessionBody.parse(request.body);
    const selected = deps.sessions.resolveShared(body.sessionId);
    if (!selected) throw new Error("shared_session_unavailable");
    reply.setCookie(
      selectedSessionCookieName(deps.config),
      selected.id,
      cookieOptions(deps.config),
    );
    return deps.sessions.snapshot(selected);
  });

  app.post("/api/sessions/new", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const browser = deps.sessions.createBrowserSession();
    reply.setCookie(
      deps.config.sessionCookieName,
      browser.token,
      cookieOptions(deps.config),
    );
    reply.clearCookie(
      selectedSessionCookieName(deps.config),
      cookieOptions(deps.config),
    );
    return deps.sessions.snapshot(browser.row);
  });

  app.post("/api/session/login", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    await deps.sessions.startLogin(session);
    reply.setCookie(
      selectedSessionCookieName(deps.config),
      session.id,
      cookieOptions(deps.config),
    );
    return deps.sessions.snapshot(deps.repository.getSession(session.id) ?? session);
  });

  app.post("/api/session/automation", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    const body = automationBody.parse(request.body);
    const updated = deps.sessions.setAutomation(session, body.enabled);
    return deps.sessions.snapshot(updated);
  });

  app.post("/api/session/reply-provider", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    const body = replyProviderBody.parse(request.body);
    const updated = deps.sessions.setReplyProvider(
      session,
      body.provider,
      body.jobNumber,
    );
    return deps.sessions.snapshot(updated);
  });

  app.post("/api/session/contact-settings", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    const body = contactSettingsBody.parse(request.body);
    const updated = deps.sessions.setContactSettings(
      session,
      body.wechatId ?? null,
      body.replyType,
    );
    return deps.sessions.snapshot(updated);
  });

  app.get("/api/session/wechat-qr", async (request) => {
    const session = requireTargetedDemoAccount(request, deps);
    return {
      accountId: session.id,
      wechatQr: deps.sessions.getAccountWechatQr(session),
    };
  });

  app.put("/api/session/wechat-qr", async (request) => {
    assertSameOrigin(request, deps.config);
    const session = requireTargetedDemoAccount(request, deps);
    const body = accountWechatQrBody.parse(request.body);
    return {
      accountId: session.id,
      wechatQr: deps.sessions.setAccountWechatQr(session, body.dataUrl),
    };
  });

  app.delete("/api/session/wechat-qr", async (request) => {
    assertSameOrigin(request, deps.config);
    const session = requireTargetedDemoAccount(request, deps);
    return {
      accountId: session.id,
      wechatQr: deps.sessions.deleteAccountWechatQr(session),
    };
  });

  app.delete("/api/session", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    deps.sessions.logout(session);
    reply.clearCookie(deps.config.sessionCookieName, cookieOptions(deps.config));
    reply.clearCookie(selectedSessionCookieName(deps.config), cookieOptions(deps.config));
    return reply.code(204).send();
  });

  // The SSE stream reconnects continuously for as long as a console tab is
  // open; its per-request incoming/completed info lines are pure volume.
  const sseRouteLogLevel = deps.config.nodeEnv === "test" ? "silent" : "warn";
  app.get("/api/events", { logLevel: sseRouteLogLevel }, async (request, reply) => {
    const session = requireSession(request, reply, deps);
    const headerId = Number(request.headers["last-event-id"] ?? 0);
    const queryId = Number((request.query as { after?: string }).after ?? 0);
    let cursor = Number.isSafeInteger(headerId) && headerId >= 0
      ? headerId
      : Number.isSafeInteger(queryId) && queryId >= 0
        ? queryId
        : 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("event: snapshot\ndata: {\"refresh\":true}\n\n");
    let closed = false;
    const timers: NodeJS.Timeout[] = [];
    const close = (): void => {
      closed = true;
      for (const timer of timers) clearInterval(timer);
    };
    request.raw.once("close", close);
    const eventsTimer = setInterval(() => {
      if (closed) return;
      const current = deps.repository.getSession(session.id);
      if (!current || !isSessionRetained(current, Date.now())) {
        reply.raw.write("event: expired\ndata: {}\n\n");
        reply.raw.end();
        close();
        return;
      }
      for (const event of deps.repository.listEvents(session.id, cursor)) {
        cursor = event.seq;
        reply.raw.write(
          `id: ${event.seq}\nevent: ${safeEventType(event.type)}\ndata: ${JSON.stringify({
            entityId: event.entityId,
            createdAt: event.createdAt,
          })}\n\n`,
        );
      }
    }, 1_000);
    const heartbeatTimer = setInterval(() => {
      if (!closed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    timers.push(eventsTimer, heartbeatTimer);
    eventsTimer.unref();
    heartbeatTimer.unref();
  });

  registerPartnerApi(app, deps);

  app.setErrorHandler((error, request, reply) => {
    const code = safeServerError(error, request);
    const statusCode = statusFor(code);
    if (code === "internal_error") {
      request.log.error({ err: error, code, statusCode }, "request failed");
    } else if (code === "ops_auth_required") {
      // Stale console tabs retry the ops-gated endpoints indefinitely; keep
      // their expected 401s out of the default info-level journal.
      request.log.debug({ code, statusCode }, "request failed");
    } else {
      request.log.warn({ code, statusCode }, "request failed");
    }
    void reply.code(statusCode).send({ error: code });
  });

  return app;
}

interface ConnectContext {
  session: SessionRow;
  accountBound: boolean;
}

async function ensureConnectContext(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): Promise<ConnectContext> {
  return resolveConnectContext(request, reply, deps)
    ?? createPendingConnectContext(reply, deps);
}

function resolveConnectContext(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): ConnectContext | null {
  const affinityName = connectAffinityCookieName(deps.config);
  const affinityId = request.cookies[affinityName];
  if (affinityId) {
    const account = deps.sessions.resolveSharedFollowingHandoff(affinityId);
    if (account) {
      if (account.id !== affinityId) {
        reply.setCookie(affinityName, account.id, cookieOptions(deps.config));
      }
      return { session: account, accountBound: true };
    }
    reply.clearCookie(affinityName, cookieOptions(deps.config));
  }

  const pendingName = connectPendingCookieName(deps.config);
  const pendingToken = request.cookies[pendingName];
  if (!pendingToken) return null;
  const pending = deps.sessions.resolve(pendingToken);
  if (!pending) {
    reply.clearCookie(pendingName, cookieOptions(deps.config));
    return null;
  }

  const linked = pending.linkedSessionId
    ? deps.sessions.resolveSharedFollowingHandoff(pending.linkedSessionId)
    : null;
  const account = linked ?? (pending.accountKeyHash ? pending : null);
  if (account) {
    reply.setCookie(affinityName, account.id, cookieOptions(deps.config));
    reply.clearCookie(pendingName, cookieOptions(deps.config));
    return { session: account, accountBound: true };
  }
  return { session: pending, accountBound: false };
}

async function createPendingConnectContext(
  reply: FastifyReply,
  deps: ServerDependencies,
): Promise<ConnectContext> {
  if (!deps.config.funnelBaseUrl) throw new Error("funnel_provider_unavailable");
  const browser = deps.sessions.createBrowserSession();
  const providerConfigured = deps.sessions.setReplyProvider(
    browser.row,
    "funnel",
    DEFAULT_FUNNEL_JOB_NUMBER,
  );
  const configured = deps.sessions.setAutomation(providerConfigured, true);
  await deps.sessions.startLogin(configured);
  reply.setCookie(
    connectPendingCookieName(deps.config),
    browser.token,
    cookieOptions(deps.config),
  );
  return {
    session: deps.repository.getSession(browser.row.id) ?? browser.row,
    accountBound: false,
  };
}

function requireConnectAccount(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): SessionRow {
  const context = resolveConnectContext(request, reply, deps);
  if (!context?.accountBound) {
    reply.code(401);
    throw new Error("connect_account_required");
  }
  return context.session;
}

async function connectSnapshot(
  session: SessionRow,
  accountBound: boolean,
  deps: ServerDependencies,
): Promise<ConnectSnapshot> {
  const snapshot = await deps.sessions.snapshot(session);
  return {
    accountBound,
    authState: snapshot.authState,
    authErrorCode: snapshot.authErrorCode,
    accountDisplayName: snapshot.accountDisplayName,
    qrDataUrl: snapshot.qrDataUrl,
    qrExpiresAt: snapshot.qrExpiresAt,
    automationEnabled: snapshot.automationEnabled,
    replyProvider: snapshot.replyProvider,
    funnelJobNumber: snapshot.funnelJobNumber,
    wechatQr: accountBound ? deps.sessions.getAccountWechatQr(session) : null,
  };
}

function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): SessionRow {
  const session = resolveRequestSession(request, reply, deps, false);
  if (!session) {
    reply.code(401);
    throw new Error("demo_session_required");
  }
  return session;
}

function requireTargetedDemoAccount(
  request: FastifyRequest,
  deps: ServerDependencies,
): SessionRow {
  const rawAccountId = request.headers["x-demo-account-id"];
  const accountId = Array.isArray(rawAccountId) ? rawAccountId[0] : rawAccountId;
  if (!accountId || !/^[A-Za-z0-9_-]{43}$/.test(accountId)) {
    throw new Error("demo_account_target_required");
  }
  const session = deps.sessions.resolveShared(accountId);
  if (!session) throw new Error("shared_session_unavailable");
  return session;
}

function resolveRequestSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
  allowOwnerFallbackAfterInvalidSelection = true,
): SessionRow | null {
  const selectedCookieName = selectedSessionCookieName(deps.config);
  const selectedId = request.cookies[selectedCookieName];
  if (selectedId) {
    const selected = deps.sessions.resolveShared(selectedId);
    if (selected) return selected;
    reply.clearCookie(selectedCookieName, cookieOptions(deps.config));
    if (!allowOwnerFallbackAfterInvalidSelection) return null;
  }
  return deps.sessions.resolve(request.cookies[deps.config.sessionCookieName]);
}

function selectedSessionCookieName(config: AppConfig): string {
  return `${config.sessionCookieName}_selected`;
}

function connectPendingCookieName(config: AppConfig): string {
  return `${config.sessionCookieName}_connect_pending`;
}

function connectAffinityCookieName(config: AppConfig): string {
  return `${config.sessionCookieName}_connect_account`;
}

function cookieOptions(config: AppConfig): {
  path: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
} {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.sessionCookieSecure,
    maxAge: config.sessionCookieMaxAgeSeconds,
  };
}

function opsCookieName(config: AppConfig): string {
  return `${config.sessionCookieName}_ops`;
}

function opsAccessValue(config: AppConfig): string {
  return createHmac("sha256", config.encryptionKey)
    .update(`ops-console:${config.opsPassword ?? ""}`)
    .digest("base64url");
}

function hasOpsAccess(request: FastifyRequest, config: AppConfig): boolean {
  const presented = request.cookies[opsCookieName(config)];
  return typeof presented === "string"
    && secretMatches(presented, opsAccessValue(config));
}

function secretMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(presented, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}

function assertSameOrigin(request: FastifyRequest, config: AppConfig): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = config.publicOrigin
    ?? `${request.protocol}://${request.headers.host ?? `${config.host}:${config.port}`}`;
  if (origin !== expected) throw new Error("cross_origin_mutation_rejected");
}

function safeEventType(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(value) ? value : "update";
}

function safeServerError(error: unknown, request: FastifyRequest): string {
  if (isBodyTooLargeError(error) && isAccountWechatQrPut(request)) {
    return "account_wechat_qr_too_large";
  }
  if (error instanceof z.ZodError) return "invalid_request";
  if (
    error instanceof Error
    && "statusCode" in error
    && error.statusCode === 400
  ) return "invalid_request";
  if (error instanceof SessionLimitError) return error.message;
  if (error instanceof Error && /^[a-z0-9_:-]{1,120}$/.test(error.message)) return error.message;
  return "internal_error";
}

function isBodyTooLargeError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

function isAccountWechatQrPut(request: FastifyRequest): boolean {
  if (request.method !== "PUT") return false;
  const path = request.url.split("?", 1)[0];
  return path === "/api/session/wechat-qr"
    || path === "/api/connect/wechat-qr"
    || /^\/partner\/v1\/accounts\/[A-Za-z0-9_-]{43}\/wechat-qr$/.test(path ?? "");
}

function statusFor(code: string): number {
  if (code === "demo_session_required") return 401;
  if (code === "connect_account_required") return 401;
  if (code === "ops_auth_required") return 401;
  if (code === "ops_password_invalid") return 401;
  if (code === "partner_api_unauthorized") return 401;
  if (code === "cross_origin_mutation_rejected") return 403;
  if (
    code === "platform_send_in_flight"
    || code === "login_in_progress"
    || code === "account_already_hosted"
  ) return 409;
  if (code === "active_session_limit_reached") return 503;
  if (
    code === "shared_session_unavailable"
    || code === "partner_account_not_found"
  ) return 404;
  if (
    code === "invalid_request"
    || code === "demo_account_target_required"
    || code === "account_wechat_qr_invalid"
    || code === "account_wechat_qr_too_large"
    || code === "invalid_cursor"
    || code === "funnel_job_number_required"
    || code === "account_wechat_id_required"
  ) return 400;
  if (
    code === "funnel_provider_unavailable"
    || code === "partner_api_unavailable"
  ) return 503;
  if (code === "partner_login_qr_unavailable") return 502;
  return 502;
}
