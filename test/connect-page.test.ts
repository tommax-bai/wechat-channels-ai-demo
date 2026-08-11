import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecureStore } from "../src/crypto.js";
import { DEFAULT_FUNNEL_JOB_NUMBER } from "../src/reply-defaults.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { DemoRepository } from "../src/repository.js";
import { buildServer } from "../src/server.js";
import { SessionService } from "../src/service/session-service.js";
import { WorkerCoordinator } from "../src/service/workers.js";
import type { ConnectSnapshot } from "../src/types.js";
import {
  FakeReplyModel,
  FakeWechatGateway,
  testConfig,
} from "./helpers.js";

const PENDING_COOKIE = "wechat_demo_session_connect_pending";
const AFFINITY_COOKIE = "wechat_demo_session_connect_account";
const TEST_QR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const REPLACEMENT_QR = "data:image/jpeg;base64,/9j/";

describe("cookie-bound connect page", () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let repository: DemoRepository;
  let gateway: FakeWechatGateway;
  let workers: WorkerCoordinator;

  beforeEach(async () => {
    const config = testConfig({ funnelBaseUrl: "http://funnel.example.test" });
    database = openDatabase(":memory:");
    repository = new DemoRepository(database);
    gateway = new FakeWechatGateway();
    const secureStore = new SecureStore(config.encryptionKey);
    const sessions = new SessionService(config, repository, secureStore, gateway);
    workers = new WorkerCoordinator(
      config,
      repository,
      secureStore,
      gateway,
      { "chat-llm": new FakeReplyModel(), funnel: new FakeReplyModel() },
    );
    app = await buildServer({ config, repository, sessions });
  });

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  it("serves the focused page and creates only one pending QR across polls", async () => {
    const server = requireApp(app);
    const page = await server.inject({ method: "GET", url: "/connect" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("01 · CONNECT");
    expect(page.body).toContain("业务微信二维码");

    const first = await server.inject({ method: "GET", url: "/api/connect" });
    expect(first.statusCode).toBe(200);
    expect(first.json<ConnectSnapshot>()).toMatchObject({
      accountBound: false,
      authState: "qr_pending",
      accountDisplayName: null,
      replyProvider: "funnel",
      funnelJobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
      wechatQr: null,
    });
    expect(first.json<ConnectSnapshot>().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const pending = responseCookie(first.headers["set-cookie"], PENDING_COOKIE);
    expect(allResponseCookies(first.headers["set-cookie"]))
      .toEqual([expect.stringMatching(new RegExp(`^${PENDING_COOKIE}=`))]);
    expect(sessionCount(database)).toBe(1);

    const second = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: pending },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<ConnectSnapshot>().qrDataUrl)
      .toBe(first.json<ConnectSnapshot>().qrDataUrl);
    expect(sessionCount(database)).toBe(1);
    expect(second.headers["set-cookie"]).toBeUndefined();

    const rejected = await server.inject({
      method: "PUT",
      url: "/api/connect/wechat-qr",
      headers: { cookie: pending, origin: "http://localhost:4310" },
      payload: { dataUrl: TEST_QR },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "connect_account_required" });
    const rejectedReplySettings = await server.inject({
      method: "POST",
      url: "/api/connect/reply-settings",
      headers: { cookie: pending, origin: "http://localhost:4310" },
      payload: { jobNumber: DEFAULT_FUNNEL_JOB_NUMBER },
    });
    expect(rejectedReplySettings.statusCode).toBe(401);
    expect(rejectedReplySettings.json()).toEqual({ error: "connect_account_required" });
  });

  it("binds a newly authenticated Finder account and restores it later", async () => {
    const server = requireApp(app);
    gateway.accountName = "finder-cookie-bound";
    const first = await server.inject({ method: "GET", url: "/api/connect" });
    const pending = responseCookie(first.headers["set-cookie"], PENDING_COOKIE);

    await workers.runOnce();
    const bound = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: pending },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json<ConnectSnapshot>()).toMatchObject({
      accountBound: true,
      authState: "active",
      accountDisplayName: "账号 finder-cookie-bound",
      replyProvider: "funnel",
      funnelJobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
    });
    const affinity = responseCookie(bound.headers["set-cookie"], AFFINITY_COOKIE);
    expect(affinity).not.toContain("finder-cookie-bound");
    expect(allResponseCookies(bound.headers["set-cookie"]))
      .toContain(`${PENDING_COOKIE}=`);
    const beforeRevisit = sessionCount(database);

    const revisit = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: affinity },
    });
    expect(revisit.statusCode).toBe(200);
    expect(revisit.json<ConnectSnapshot>()).toMatchObject({
      accountBound: true,
      accountDisplayName: "账号 finder-cookie-bound",
    });
    expect(revisit.json<ConnectSnapshot>().qrDataUrl).toBeNull();
    expect(sessionCount(database)).toBe(beforeRevisit);

    const invalid = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: `${AFFINITY_COOKIE}=${"A".repeat(43)}` },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json<ConnectSnapshot>()).toMatchObject({
      accountBound: false,
      authState: "qr_pending",
    });
    expect(responseCookie(invalid.headers["set-cookie"], PENDING_COOKIE))
      .toContain(`${PENDING_COOKIE}=`);
  });

  it("hands a duplicate Finder login to the retained account with its QR intact", async () => {
    const server = requireApp(app);
    gateway.accountName = "finder-shared-connect";
    const ownerStart = await server.inject({ method: "GET", url: "/api/connect" });
    const ownerPending = responseCookie(ownerStart.headers["set-cookie"], PENDING_COOKIE);
    await workers.runOnce();
    const ownerBound = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: ownerPending },
    });
    const ownerAffinity = responseCookie(ownerBound.headers["set-cookie"], AFFINITY_COOKIE);
    const configured = await server.inject({
      method: "PUT",
      url: "/api/connect/wechat-qr",
      headers: { cookie: ownerAffinity, origin: "http://localhost:4310" },
      payload: { dataUrl: TEST_QR },
    });
    expect(configured.statusCode).toBe(200);

    const visitorStart = await server.inject({ method: "GET", url: "/api/connect" });
    const visitorPending = responseCookie(visitorStart.headers["set-cookie"], PENDING_COOKIE);
    await workers.runOnce();
    const visitorBound = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: visitorPending },
    });
    expect(visitorBound.statusCode).toBe(200);
    expect(visitorBound.json<ConnectSnapshot>()).toMatchObject({
      accountBound: true,
      accountDisplayName: "账号 finder-shared-connect",
      wechatQr: { configured: true, mimeType: "image/png", dataUrl: TEST_QR },
    });
    const visitorAffinity = responseCookie(
      visitorBound.headers["set-cookie"],
      AFFINITY_COOKIE,
    );
    expect(visitorAffinity).toBe(ownerAffinity);
    const linkedRows = database?.prepare(`
      SELECT COUNT(*) AS count FROM demo_sessions
      WHERE linked_session_id IS NOT NULL
        AND last_error_code = 'account_already_connected'
    `).get() as { count: number } | undefined;
    expect(linkedRows?.count).toBe(1);
  });

  it("preserves a retained CHAT account until explicit save and lists it once on the dashboard", async () => {
    const server = requireApp(app);
    gateway.accountName = "finder-existing-chat";
    const owner = await server.inject({
      method: "POST",
      url: "/api/sessions/new",
      headers: { origin: "http://localhost:4310" },
      payload: {},
    });
    const ownerCookie = responseCookie(
      owner.headers["set-cookie"],
      "wechat_demo_session",
    );
    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/session/login",
      headers: { cookie: ownerCookie, origin: "http://localhost:4310" },
      payload: {},
    });
    expect(ownerLogin.statusCode).toBe(200);
    await workers.runOnce();

    const focused = await server.inject({ method: "GET", url: "/api/connect" });
    const pending = responseCookie(focused.headers["set-cookie"], PENDING_COOKIE);
    await workers.runOnce();
    const bound = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: pending },
    });
    expect(bound.json<ConnectSnapshot>()).toMatchObject({
      accountBound: true,
      accountDisplayName: "账号 finder-existing-chat",
      replyProvider: "chat-llm",
      funnelJobNumber: null,
    });
    const affinity = responseCookie(bound.headers["set-cookie"], AFFINITY_COOKIE);

    const saved = await server.inject({
      method: "POST",
      url: "/api/connect/reply-settings",
      headers: { cookie: affinity, origin: "http://localhost:4310" },
      payload: { jobNumber: DEFAULT_FUNNEL_JOB_NUMBER },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ConnectSnapshot>()).toMatchObject({
      replyProvider: "funnel",
      funnelJobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
    });

    const shared = await server.inject({ method: "GET", url: "/api/sessions" });
    const sessions = shared.json<{
      sessions: Array<{
        sessionId: string;
        accountDisplayName: string;
        replyProvider: string;
        funnelJobNumber: string | null;
      }>;
    }>().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      accountDisplayName: "账号 finder-existing-chat",
      replyProvider: "funnel",
      funnelJobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
    });
    const selected = await server.inject({
      method: "POST",
      url: "/api/sessions/select",
      headers: { origin: "http://localhost:4310" },
      payload: { sessionId: sessions[0]?.sessionId },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      replyProvider: "funnel",
      funnelJobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
    });
  });

  it("uploads, replaces, reads, and deletes the bound account business QR", async () => {
    const server = requireApp(app);
    const start = await server.inject({ method: "GET", url: "/api/connect" });
    const pending = responseCookie(start.headers["set-cookie"], PENDING_COOKIE);
    await workers.runOnce();
    const completed = await server.inject({
      method: "GET",
      url: "/api/connect",
      headers: { cookie: pending },
    });
    const affinity = responseCookie(completed.headers["set-cookie"], AFFINITY_COOKIE);

    for (const [dataUrl, mimeType] of [
      [TEST_QR, "image/png"],
      [REPLACEMENT_QR, "image/jpeg"],
    ] as const) {
      const saved = await server.inject({
        method: "PUT",
        url: "/api/connect/wechat-qr",
        headers: { cookie: affinity, origin: "http://localhost:4310" },
        payload: { dataUrl },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        wechatQr: { configured: true, mimeType, dataUrl },
      });
    }

    const read = await server.inject({
      method: "GET",
      url: "/api/connect/wechat-qr",
      headers: { cookie: affinity },
    });
    expect(read.json()).toMatchObject({
      wechatQr: { configured: true, mimeType: "image/jpeg", dataUrl: REPLACEMENT_QR },
    });

    const removed = await server.inject({
      method: "DELETE",
      url: "/api/connect/wechat-qr",
      headers: { cookie: affinity, origin: "http://localhost:4310" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({
      wechatQr: {
        configured: false,
        mimeType: null,
        byteLength: null,
        updatedAt: null,
        dataUrl: null,
      },
    });
  });
});

function requireApp(app: FastifyInstance | undefined): FastifyInstance {
  if (!app) throw new Error("test app was not created");
  return app;
}

function sessionCount(database: SqliteDatabase | undefined): number {
  const row = database?.prepare("SELECT COUNT(*) AS count FROM demo_sessions").get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function allResponseCookies(header: string | string[] | undefined): string[] {
  return (Array.isArray(header) ? header : header ? [header] : [])
    .map((value) => value.split(";", 1)[0] ?? "");
}

function responseCookie(
  header: string | string[] | undefined,
  name: string,
): string {
  const cookie = allResponseCookies(header)
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`missing ${name} cookie`);
  return cookie;
}
