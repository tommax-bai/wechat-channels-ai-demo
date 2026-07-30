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
import type { DemoRepository, SessionRow } from "./repository.js";
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
    if (request.url.startsWith("/api/") || request.url === "/") {
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
    autoReplyEnabled: deps.config.autoReplyEnabled,
  }));

  app.get("/api/session", async (request, reply) => {
    const session = ensureSession(request, reply, deps);
    return deps.sessions.snapshot(session);
  });

  app.post("/api/session/login", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    await deps.sessions.startLogin(session);
    return deps.sessions.snapshot(deps.repository.getSession(session.id) ?? session);
  });

  app.post("/api/session/automation", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    const body = automationBody.parse(request.body);
    const updated = deps.sessions.setAutomation(session, body.enabled);
    return deps.sessions.snapshot(updated);
  });

  app.delete("/api/session", async (request, reply) => {
    assertSameOrigin(request, deps.config);
    const session = requireSession(request, reply, deps);
    deps.sessions.logout(session);
    reply.clearCookie(deps.config.sessionCookieName, cookieOptions(deps.config));
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
      if (!current || current.expiresAt <= Date.now()) {
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

  app.setErrorHandler((error, request, reply) => {
    const code = safeServerError(error);
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
  const session = deps.sessions.resolve(request.cookies[deps.config.sessionCookieName]);
  if (!session) {
    reply.code(401);
    throw new Error("demo_session_required");
  }
  return session;
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
    maxAge: Math.floor(config.sessionTtlMs / 1_000),
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

function safeServerError(error: unknown): string {
  if (error instanceof z.ZodError) return "invalid_request";
  if (error instanceof SessionLimitError) return error.message;
  if (error instanceof Error && /^[a-z0-9_:-]{1,120}$/.test(error.message)) return error.message;
  return "internal_error";
}

function statusFor(code: string): number {
  if (code === "demo_session_required") return 401;
  if (code === "cross_origin_mutation_rejected") return 403;
  if (code === "platform_send_in_flight") return 409;
  if (code === "active_session_limit_reached") return 503;
  if (code === "invalid_request") return 400;
  return 502;
}
