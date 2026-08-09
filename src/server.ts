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
import {
  isSessionRetained,
  type DemoRepository,
  type SessionRow,
} from "./repository.js";
import {
  SessionLimitError,
  type SessionService,
} from "./service/session-service.js";

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
const selectSessionBody = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
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

  app.get("/api/session", async (request, reply) => {
    const session = ensureSession(request, reply, deps);
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

  app.get("/api/events", async (request, reply) => {
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
    } else {
      request.log.warn({ code, statusCode }, "request failed");
    }
    void reply.code(statusCode).send({ error: code });
  });

  return app;
}

function ensureSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): SessionRow {
  const selected = resolveRequestSession(request, reply, deps);
  if (selected) return selected;
  const browser = deps.sessions.ensureBrowserSession(
    request.cookies[deps.config.sessionCookieName],
  );
  if (browser.created) {
    reply.setCookie(
      deps.config.sessionCookieName,
      browser.token,
      cookieOptions(deps.config),
    );
  }
  return browser.row;
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
    || /^\/partner\/v1\/accounts\/[A-Za-z0-9_-]{43}\/wechat-qr$/.test(path ?? "");
}

function statusFor(code: string): number {
  if (code === "demo_session_required") return 401;
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
  ) return 400;
  if (
    code === "funnel_provider_unavailable"
    || code === "partner_api_unavailable"
  ) return 503;
  if (code === "partner_login_qr_unavailable") return 502;
  return 502;
}
