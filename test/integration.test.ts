import type { FastifyInstance } from "fastify";
import { CookieJar } from "tough-cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecureStore } from "../src/crypto.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { ModelError } from "../src/model/reply-model.js";
import { DemoRepository } from "../src/repository.js";
import { buildServer } from "../src/server.js";
import { SessionService } from "../src/service/session-service.js";
import type { StoredCredential } from "../src/service/credentials.js";
import { WorkerCoordinator } from "../src/service/workers.js";
import type { SessionSnapshot } from "../src/types.js";
import { WechatApiError } from "../src/wechat/transport.js";
import {
  FakeReplyModel,
  FakeWechatGateway,
  fakeComment,
  fakeDm,
  testConfig,
} from "./helpers.js";

const TEST_ACCOUNT_WECHAT_QR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const REPLACEMENT_ACCOUNT_WECHAT_QR = "data:image/jpeg;base64,/9j/";

describe("multi-user demo flow", () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let repository: DemoRepository;
  let secureStore: SecureStore;
  let gateway: FakeWechatGateway;
  let model: FakeReplyModel;
  let funnelModel: FakeReplyModel;
  let workers: WorkerCoordinator;

  beforeEach(async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    repository = new DemoRepository(database);
    secureStore = new SecureStore(config.encryptionKey);
    gateway = new FakeWechatGateway();
    model = new FakeReplyModel();
    funnelModel = new FakeReplyModel();
    const sessions = new SessionService(config, repository, secureStore, gateway);
    workers = new WorkerCoordinator(
      config,
      repository,
      secureStore,
      gateway,
      { "chat-llm": model, funnel: funnelModel },
    );
    app = await buildServer({ config, repository, sessions });
  });

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  it("isolates two visitors and replies only to a post-baseline item", async () => {
    const server = requireApp(app);
    const a = await bootstrap(server);
    const b = await bootstrap(server);
    expect(a.cookie).not.toBe(b.cookie);

    await startLogin(server, a.cookie);
    await startLogin(server, b.cookie);
    await workers.runOnce();

    const activeA = await snapshot(server, a.cookie);
    const activeB = await snapshot(server, b.cookie);
    expect(activeA.authState).toBe("active");
    expect(activeB.authState).toBe("active");
    expect(activeA.accountDisplayName).not.toBe(activeB.accountDisplayName);
    expect(activeA.timeline).toHaveLength(1);
    expect(activeA.timeline[0]?.historical).toBe(true);
    expect(activeA.timeline[0]?.replyState).toBeNull();

    gateway.newItems.set("finder-1", [fakeDm("new-a", "finder-1", "请问怎么购买？")]);
    await workers.runOnce();

    const updatedA = await snapshot(server, a.cookie);
    const untouchedB = await snapshot(server, b.cookie);
    const newItem = updatedA.timeline.find((item) => item.text === "请问怎么购买？");
    expect(newItem).toMatchObject({
      historical: false,
      replyState: "confirmed",
      replyText: "您好，已收到：请问怎么购买？",
    });
    expect(untouchedB.timeline.some((item) => item.text === "请问怎么购买？")).toBe(false);
    expect(gateway.sends).toHaveLength(1);
    expect(model.calls).toHaveLength(1);

    const persisted = JSON.stringify(
      database?.prepare(`
        SELECT payload_envelope FROM inbound_items
        UNION ALL
        SELECT output_envelope FROM reply_jobs WHERE output_envelope IS NOT NULL
      `).all(),
    );
    expect(persisted).not.toContain("请问怎么购买？");
    expect(persisted).not.toContain("您好，已收到");
    const receipt = database?.prepare(
      "SELECT platform_receipt_hash AS value FROM reply_jobs WHERE state = 'confirmed'",
    ).get() as { value: string } | undefined;
    expect(receipt?.value.length).toBeGreaterThan(20);
  });

  it("keeps a pre-login item historical while answering a post-login item behind newer content", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const sessionId = requireSessionId(database);
    const loginAt = requireLoginAnchor(database, sessionId);

    // Store something newer first: the retired watermark would have blocked the later arrival
    // below, so this ordering is what proves eligibility anchors on the login, not on storage.
    gateway.newItems.set("finder-1", [
      fakeDm("post-login-newest", "finder-1", "最新的私信", loginAt + 120_000),
    ]);
    await workers.runOnce();

    gateway.newItems.set("finder-1", [
      fakeDm("pre-login", "finder-1", "登录之前的旧私信", loginAt - 60_000),
      fakeDm("post-login-behind-newest", "finder-1", "晚发现的登录后私信", loginAt + 60_000),
    ]);
    await workers.runOnce();

    const timeline = (await snapshot(server, visitor.cookie)).timeline;
    expect(timeline.find((item) => item.text === "登录之前的旧私信"))
      .toMatchObject({ historical: true, replyState: null });
    expect(timeline.find((item) => item.text === "晚发现的登录后私信"))
      .toMatchObject({ historical: false, replyState: "confirmed" });
    expect(gateway.sends).toHaveLength(2);
  });

  it("answers a post-login direct message surfaced while the baseline still walks", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    // The item must postdate the login the same tick performs, so its timestamp sits slightly in
    // the future relative to this line; the anchor is stamped between here and the baseline walk.
    gateway.baselineExtraItems.push(
      fakeDm("during-baseline", "finder-1", "基线期间的新私信", Date.now() + 5_000),
    );
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const timeline = (await snapshot(server, visitor.cookie)).timeline;
    expect(timeline.find((item) => item.text === "历史消息"))
      .toMatchObject({ historical: true, replyState: null });
    expect(timeline.find((item) => item.text === "基线期间的新私信"))
      .toMatchObject({ historical: false, replyState: "confirmed" });
    expect(gateway.sends).toHaveLength(1);
  });

  it("re-anchors on a fresh scan so logged-out-gap messages stay historical", async () => {
    const server = requireApp(app);
    // Pin the platform account so the re-scan below reconnects the same identity.
    gateway.accountName = "finder-1";
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    // Pretend the first login happened hours ago, then re-scan: the anchor must move to the new
    // login, so a message from the logged-out gap is backlog even though the old anchor predates it.
    const sessionId = requireSessionId(database);
    const backdated = Date.now() - 3 * 3_600_000;
    database?.prepare("UPDATE demo_sessions SET last_login_at = ? WHERE id = ?")
      .run(backdated, sessionId);

    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    const reanchored = requireLoginAnchor(database, sessionId);
    expect(reanchored).toBeGreaterThan(backdated);

    gateway.newItems.set("finder-1", [
      fakeDm("logged-out-gap", "finder-1", "掉线期间的私信", Date.now() - 3_600_000),
      fakeDm("fresh-after-rescan", "finder-1", "重新扫码后的私信"),
    ]);
    await workers.runOnce();

    const timeline = (await snapshot(server, visitor.cookie)).timeline;
    expect(timeline.find((item) => item.text === "掉线期间的私信"))
      .toMatchObject({ historical: true, replyState: null });
    expect(timeline.find((item) => item.text === "重新扫码后的私信"))
      .toMatchObject({ historical: false, replyState: "confirmed" });
    expect(gateway.sends).toHaveLength(1);
  });

  it("stores a long-delayed direct message without replying to it", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    // Backdate the anchor so the stale message below is post-login: the age cap alone must be
    // what holds it back, keeping the two brakes independently testable.
    const sessionId = requireSessionId(database);
    database?.prepare("UPDATE demo_sessions SET last_login_at = ? WHERE id = ?")
      .run(Date.now() - 8 * 3_600_000, sessionId);

    // A lane that was blind for hours must not wake up and answer the whole backlog at once.
    gateway.newItems.set("finder-1", [
      fakeDm("stale-backlog", "finder-1", "六小时前发来的私信", Date.now() - 7 * 3_600_000),
    ]);
    await workers.runOnce();

    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "六小时前发来的私信"))
      .toMatchObject({ historical: true, replyState: null });
    expect(gateway.sends).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it("allows only one active demo session for the same platform account", async () => {
    const server = requireApp(app);
    gateway.accountName = "finder-shared";
    const a = await bootstrap(server);
    const b = await bootstrap(server);

    await startLogin(server, a.cookie);
    await startLogin(server, b.cookie);
    await workers.runOnce();

    const states = [
      (await snapshot(server, a.cookie)).authState,
      (await snapshot(server, b.cookie)).authState,
    ];
    expect(states).toContain("active");
    expect(states).toContain("auth_required");
  });

  it("persists the provisional platform session before bounded browser capture", async () => {
    const server = requireApp(app);
    gateway.captureRequired = true;
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    const captureGate = gateway.blockNextLoginCapture();
    const run = workers.runOnce();
    await captureGate.started;

    const duringCapture = await snapshot(server, visitor.cookie);
    expect(duringCapture.authState).toBe("capturing_context");
    expect(duringCapture.authErrorCode).toBeNull();
    const sessionId = requireSessionId(database);
    const envelope = repository.getCredentialEnvelope(sessionId);
    if (!envelope) throw new Error("missing capture credential envelope");
    const stored = secureStore.decryptJson<StoredCredential>(
      envelope,
      sessionId,
      "credentials",
    );
    expect(stored.kind).toBe("capturing");

    captureGate.release();
    await run;
    expect((await snapshot(server, visitor.cookie)).authState).toBe("active");
    expect(gateway.captureCalls).toBe(1);
  });

  it("lists and switches shared logged-in sessions without replacing the browser session", async () => {
    const server = requireApp(app);
    const accountOwner = await bootstrap(server);
    await startLogin(server, accountOwner.cookie);
    await workers.runOnce();

    const countBeforeAnonymousList = database
      ?.prepare("SELECT COUNT(*) AS value FROM demo_sessions")
      .get() as { value: number } | undefined;
    const anonymousList = await server.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(anonymousList.statusCode).toBe(200);
    expect(anonymousList.headers["set-cookie"]).toBeUndefined();
    expect(anonymousList.json<{ selectedSessionId: string | null }>().selectedSessionId)
      .toBeNull();
    const countAfterAnonymousList = database
      ?.prepare("SELECT COUNT(*) AS value FROM demo_sessions")
      .get() as { value: number } | undefined;
    expect(countAfterAnonymousList?.value).toBe(countBeforeAnonymousList?.value);

    const visitor = await bootstrap(server);
    const listed = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: visitor.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const shared = listed.json<{
      selectedSessionId: string | null;
      sessions: Array<{
        sessionId: string;
        accountDisplayName: string;
        authState: string;
      }>;
    }>();
    expect(shared.sessions).toHaveLength(1);
    expect(shared.sessions[0]).toMatchObject({
      accountDisplayName: "账号 finder-1",
      authState: "active",
    });

    const selected = await server.inject({
      method: "POST",
      url: "/api/sessions/select",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: { sessionId: shared.sessions[0]?.sessionId },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json<SessionSnapshot>().accountDisplayName).toBe("账号 finder-1");
    const selectedCookie = responseCookie(
      selected.headers["set-cookie"],
      "wechat_demo_session_selected",
    );
    const switched = await snapshot(
      server,
      `${visitor.cookie}; ${selectedCookie}`,
    );
    expect(switched.accountDisplayName).toBe("账号 finder-1");

    const created = await server.inject({
      method: "POST",
      url: "/api/sessions/new",
      headers: {
        cookie: `${visitor.cookie}; ${selectedCookie}`,
        origin: "http://localhost:4310",
      },
      payload: {},
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<SessionSnapshot>().authState).toBe("new");
    const newOwnerCookie = responseCookie(
      created.headers["set-cookie"],
      "wechat_demo_session",
    );
    expect((await snapshot(server, newOwnerCookie)).authState).toBe("new");

    const preserved = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: newOwnerCookie },
    });
    expect(preserved.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);
  });

  it("keeps shared mutations on the selected account and never falls back after an invalid selection", async () => {
    const server = requireApp(app);
    const a = await bootstrap(server);
    await startLogin(server, a.cookie);
    await workers.runOnce();
    const b = await bootstrap(server);
    await startLogin(server, b.cookie);
    await workers.runOnce();

    const listed = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: b.cookie },
    });
    const sessions = listed.json<{
      sessions: Array<{ sessionId: string; accountDisplayName: string }>;
    }>().sessions;
    const accountA = sessions.find(
      (session) => session.accountDisplayName === "账号 finder-1",
    );
    if (!accountA) throw new Error("missing shared account A");

    const selected = await server.inject({
      method: "POST",
      url: "/api/sessions/select",
      headers: { cookie: b.cookie, origin: "http://localhost:4310" },
      payload: { sessionId: accountA.sessionId },
    });
    const selectedCookie = responseCookie(
      selected.headers["set-cookie"],
      "wechat_demo_session_selected",
    );
    const selectedHeaders = {
      cookie: `${b.cookie}; ${selectedCookie}`,
      origin: "http://localhost:4310",
    };
    const stopped = await server.inject({
      method: "POST",
      url: "/api/session/automation",
      headers: selectedHeaders,
      payload: { enabled: false },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json<SessionSnapshot>().accountDisplayName).toBe("账号 finder-1");
    expect(stopped.json<SessionSnapshot>().authState).toBe("stopped");
    expect((await snapshot(server, a.cookie)).authState).toBe("stopped");
    expect((await snapshot(server, b.cookie)).authState).toBe("active");

    const refreshed = await server.inject({
      method: "POST",
      url: "/api/session/login",
      headers: selectedHeaders,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<SessionSnapshot>().authState).toBe("qr_pending");
    expect((await snapshot(
      server,
      `${b.cookie}; ${selectedCookie}`,
    )).authState).toBe("qr_pending");
    expect((await snapshot(server, b.cookie)).authState).toBe("active");

    const invalidSelectedCookie = `wechat_demo_session_selected=${"x".repeat(43)}`;
    const rejected = await server.inject({
      method: "POST",
      url: "/api/session/automation",
      headers: {
        cookie: `${b.cookie}; ${invalidSelectedCookie}`,
        origin: "http://localhost:4310",
      },
      payload: { enabled: false },
    });
    expect(rejected.statusCode).toBe(401);
    expect((await snapshot(server, b.cookie)).authState).toBe("active");

    const invalidList = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: `${b.cookie}; ${invalidSelectedCookie}` },
    });
    expect(invalidList.statusCode).toBe(200);
    expect(invalidList.json<{ selectedSessionId: string | null }>().selectedSessionId)
      .toBeNull();
  });

  it("admits and persists an account-scoped reply provider setting", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const missingJob = await server.inject({
      method: "POST",
      url: "/api/session/reply-provider",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: { provider: "funnel", jobNumber: "   " },
    });
    expect(missingJob.statusCode).toBe(400);
    expect(missingJob.json()).toEqual({ error: "funnel_job_number_required" });

    const unavailable = await server.inject({
      method: "POST",
      url: "/api/session/reply-provider",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: { provider: "funnel", jobNumber: "job-42" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: "funnel_provider_unavailable" });
    expect((await snapshot(server, visitor.cookie)).replyProvider).toBe("chat-llm");

    await server.close();
    app = undefined;
    const configured = testConfig({
      funnelBaseUrl: "http://funnel.example.test",
      funnelTimeoutMs: 1_000,
    });
    const sessions = new SessionService(
      configured,
      repository,
      secureStore,
      gateway,
    );
    app = await buildServer({ config: configured, repository, sessions });
    const configuredServer = requireApp(app);
    const selected = await configuredServer.inject({
      method: "POST",
      url: "/api/session/reply-provider",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: { provider: "funnel", jobNumber: "  job-42  " },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json<SessionSnapshot>()).toMatchObject({
      replyProvider: "funnel",
      funnelJobNumber: "job-42",
      automationEnabled: true,
      service: {
        autoReplyEnabled: true,
        modelConfigured: true,
        chatReplyConfigured: true,
        funnelReplyConfigured: true,
        selectedProviderConfigured: true,
      },
    });
    expect(await snapshot(configuredServer, visitor.cookie)).toMatchObject({
      replyProvider: "funnel",
      funnelJobNumber: "job-42",
    });

    const listed = await configuredServer.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: visitor.cookie },
    });
    expect(listed.json<{ sessions: Array<Record<string, unknown>> }>().sessions[0])
      .toMatchObject({ replyProvider: "funnel", funnelJobNumber: "job-42" });

    const backToChat = await configuredServer.inject({
      method: "POST",
      url: "/api/session/reply-provider",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: { provider: "chat-llm" },
    });
    expect(backToChat.json<SessionSnapshot>()).toMatchObject({
      replyProvider: "chat-llm",
      funnelJobNumber: "job-42",
    });
  });

  it("uses the selected funnel provider and sends DM bubbles in order", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    const sessionId = requireSessionId(database);
    repository.setReplyProvider(sessionId, "funnel", "job-42", Date.now());
    funnelModel.result = {
      text: "第一条\n第二条",
      messages: ["第一条", "第二条"],
      disposition: "reply",
      model: "funnel",
      requestId: "funnel-request-1",
    };
    const firstDm = fakeDm("funnel-dm-1", "finder-1", "多少钱");
    if (firstDm.target.kind === "dm") firstDm.target.sessionId = "stable-platform-session";
    gateway.newItems.set("finder-1", [firstDm]);

    await workers.runOnce();

    expect(model.calls).toHaveLength(0);
    expect(funnelModel.calls).toHaveLength(1);
    expect(funnelModel.calls[0]).toMatchObject({
      source: "dm",
      text: "多少钱",
      jobNumber: "job-42",
    });
    expect(funnelModel.calls[0]?.conversationId).toMatch(/^wechat-channels-/);
    expect(funnelModel.calls[0]?.conversationId).not.toContain("session-funnel-dm-1");
    expect(funnelModel.calls[0]?.messageId).toMatch(/^wechat-channels-/);
    expect(funnelModel.calls[0]?.messageId).not.toContain("funnel-dm-1");
    expect(gateway.sends.map((send) => send.text)).toEqual(["第一条", "第二条"]);
    expect(new Set(gateway.sends.map((send) => send.clientId)).size).toBe(2);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "多少钱")).toMatchObject({
        replyText: "第一条\n第二条",
        replyState: "confirmed",
      });

    const firstConversationId = funnelModel.calls[0]?.conversationId;
    repository.setReplyProvider(sessionId, "funnel", "job-99", Date.now());
    funnelModel.result = {
      text: "新岗位回复",
      messages: ["新岗位回复"],
      disposition: "reply",
      model: "funnel",
    };
    const secondDm = fakeDm("funnel-dm-2", "finder-1", "还是这个岗位吗");
    if (secondDm.target.kind === "dm") secondDm.target.sessionId = "stable-platform-session";
    gateway.newItems.set("finder-1", [secondDm]);
    await workers.runOnce();
    expect(funnelModel.calls[1]).toMatchObject({ jobNumber: "job-99" });
    expect(funnelModel.calls[1]?.conversationId).not.toBe(firstConversationId);
  });

  it("sends the configured account QR after ordered Funnel DM bubbles", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    const sessionId = requireSessionId(database);
    repository.setReplyProvider(sessionId, "funnel", "job-42", Date.now());
    await configureAccountWechatQr(server, visitor.cookie);
    funnelModel.result = {
      text: "第一条\n我把二维码发你",
      messages: ["第一条", "我把二维码发你"],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
      requestId: "funnel-qr-request-1",
    };
    const inbound = fakeDm("funnel-qr-1", "finder-1", "发二维码吧");
    if (inbound.target.kind === "dm") {
      inbound.target.sessionId = "qr-conversation-1";
    }
    gateway.newItems.set("finder-1", [inbound]);

    await workers.runOnce();

    expect(gateway.sends.map((send) => send.text)).toEqual([
      "第一条",
      "我把二维码发你",
    ]);
    expect(gateway.imageSends).toHaveLength(1);
    expect(gateway.imageSends[0]).toMatchObject({
      target: { kind: "dm", sessionId: "qr-conversation-1" },
      asset: { mimeType: "image/png" },
    });
    const baseClientId = gateway.sends[0]?.clientId;
    expect(baseClientId).toBeTruthy();
    expect(gateway.sends[1]?.clientId).toBe(`${baseClientId}-2`);
    expect(gateway.imageSends[0]?.clientId).toBe(`${baseClientId}-3`);
    expect(Buffer.from(gateway.imageSends[0]?.asset.bytes ?? []).toString("base64"))
      .toBe(TEST_ACCOUNT_WECHAT_QR.split(",", 2)[1]);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "发二维码吧")).toMatchObject({
        replyText: "第一条\n我把二维码发你",
        replyState: "confirmed",
        replyErrorCode: null,
      });
  });

  it("fails a Funnel QR action before sending text when the account QR is missing", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    repository.setReplyProvider(
      requireSessionId(database),
      "funnel",
      "job-42",
      Date.now(),
    );
    funnelModel.result = {
      text: "我把二维码发你",
      messages: ["我把二维码发你"],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
      requestId: "funnel-qr-missing-request",
    };
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-qr-missing", "finder-1", "二维码呢"),
    ]);

    await workers.runOnce();

    expect(gateway.sends).toHaveLength(0);
    expect(gateway.imageSends).toHaveLength(0);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "二维码呢")).toMatchObject({
        replyState: "failed",
        replyErrorCode: "account_wechat_qr_not_configured",
      });
    expect(database?.prepare(`
      SELECT provider_request_id AS requestId
      FROM reply_jobs WHERE error_code = 'account_wechat_qr_not_configured'
    `).get()).toEqual({ requestId: "funnel-qr-missing-request" });
  });

  it("does not skip an action-only QR reply and does not retry an ambiguous image send", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    repository.setReplyProvider(
      requireSessionId(database),
      "funnel",
      "job-42",
      Date.now(),
    );
    await configureAccountWechatQr(server, visitor.cookie);
    funnelModel.result = {
      text: "",
      messages: [],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
    };
    gateway.imageSendError = new WechatApiError(
      "image_send_timeout",
      "dmSendText",
      true,
    );
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-qr-action-only", "finder-1", "直接发吧"),
    ]);

    await workers.runOnce();

    expect(gateway.sends).toHaveLength(0);
    expect(gateway.imageSends).toHaveLength(1);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "直接发吧")).toMatchObject({
        replyText: "",
        replyAction: "send_wechat_qr",
        replyState: "submitted_unknown",
        replyErrorCode: "image_send_timeout",
      });
    await workers.runOnce();
    expect(gateway.imageSends).toHaveLength(1);
    expect(funnelModel.calls).toHaveLength(1);
  });

  it("records a text-confirmed QR upload failure as submitted unknown without replay", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    repository.setReplyProvider(
      requireSessionId(database),
      "funnel",
      "job-42",
      Date.now(),
    );
    await configureAccountWechatQr(server, visitor.cookie);
    funnelModel.result = {
      text: "我把二维码发你",
      messages: ["我把二维码发你"],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
    };
    gateway.imageSendError = new WechatApiError(
      "image_upload_rejected",
      "dmUploadMedia",
      false,
    );
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-qr-partial", "finder-1", "发一下二维码"),
    ]);

    await workers.runOnce();

    expect(gateway.sends.map((send) => send.text)).toEqual(["我把二维码发你"]);
    expect(gateway.imageSends).toHaveLength(1);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "发一下二维码")).toMatchObject({
        replyState: "submitted_unknown",
        replyErrorCode: "image_upload_rejected",
      });
    await workers.runOnce();
    expect(gateway.sends).toHaveLength(1);
    expect(gateway.imageSends).toHaveLength(1);
  });

  it("does not send a prevalidated QR after the account asset is deleted", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    const sessionId = requireSessionId(database);
    repository.setReplyProvider(sessionId, "funnel", "job-42", Date.now());
    await configureAccountWechatQr(server, visitor.cookie);
    funnelModel.result = {
      text: "",
      messages: [],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
    };
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-qr-deleted-before-send", "finder-1", "把二维码发来"),
    ]);

    const gate = gateway.blockNextSend();
    const pendingRun = workers.runOnce();
    await gate.started;
    const deleted = await server.inject({
      method: "DELETE",
      url: "/api/session/wechat-qr",
      headers: {
        cookie: visitor.cookie,
        origin: "http://localhost:4310",
        "x-demo-account-id": sessionId,
      },
    });
    expect(deleted.statusCode).toBe(200);
    gate.release();
    await pendingRun;

    expect(gateway.sends).toHaveLength(0);
    expect(gateway.imageSends).toHaveLength(0);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "把二维码发来")).toMatchObject({
        replyState: "failed",
        replyErrorCode: "dispatch_not_authorized",
      });
    await workers.runOnce();
    expect(gateway.imageSends).toHaveLength(0);
  });

  it("stops remaining bubbles and the old QR when the account asset changes", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    const sessionId = requireSessionId(database);
    repository.setReplyProvider(sessionId, "funnel", "job-42", Date.now());
    await configureAccountWechatQr(server, visitor.cookie);
    funnelModel.result = {
      text: "第一条\n二维码马上发你",
      messages: ["第一条", "二维码马上发你"],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
    };
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-qr-replaced-before-image", "finder-1", "发新的二维码"),
    ]);

    const gate = gateway.blockNextSendAfterDispatch();
    const pendingRun = workers.runOnce();
    await gate.started;
    const replaced = await server.inject({
      method: "PUT",
      url: "/api/session/wechat-qr",
      headers: {
        cookie: visitor.cookie,
        origin: "http://localhost:4310",
        "x-demo-account-id": sessionId,
      },
      payload: { dataUrl: REPLACEMENT_ACCOUNT_WECHAT_QR },
    });
    expect(replaced.statusCode).toBe(200);
    gate.release();
    await pendingRun;

    expect(gateway.sends.map((send) => send.text)).toEqual(["第一条"]);
    expect(gateway.imageSends).toHaveLength(0);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "发新的二维码")).toMatchObject({
        replyState: "submitted_unknown",
        replyErrorCode: "dispatch_not_authorized",
      });
    await workers.runOnce();
    expect(gateway.sends).toHaveLength(1);
    expect(gateway.imageSends).toHaveLength(0);
  });

  it("records an empty funnel comment reply as skipped without a platform write", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    repository.setReplyProvider(
      requireSessionId(database),
      "funnel",
      "job-42",
      Date.now(),
    );
    funnelModel.result = {
      text: "",
      messages: [],
      disposition: "skip",
      model: "funnel",
    };
    gateway.newComments.set("finder-1", [
      fakeComment("comment-skip-1", "哈哈哈哈"),
    ]);

    await workers.runOnce();

    expect(model.calls).toHaveLength(0);
    expect(funnelModel.calls).toHaveLength(1);
    expect(funnelModel.calls[0]).toMatchObject({
      source: "comment",
      text: "哈哈哈哈",
      jobNumber: "job-42",
    });
    expect(gateway.sends).toHaveLength(0);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "哈哈哈哈")).toMatchObject({
        replyText: "",
        replyState: "skipped",
      });
  });

  it("does not fall back to CHAT when funnel generation fails", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    repository.setReplyProvider(
      requireSessionId(database),
      "funnel",
      "job-42",
      Date.now(),
    );
    funnelModel.error = new ModelError(
      "funnel_test_failure",
      "funnel-failed-request",
    );
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-failure-1", "finder-1", "测试失败"),
    ]);

    await workers.runOnce();

    expect(funnelModel.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(gateway.sends).toHaveLength(0);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "测试失败")).toMatchObject({
        replyState: "failed",
        replyErrorCode: "funnel_test_failure",
      });
    expect(database?.prepare(`
      SELECT provider_request_id AS requestId
      FROM reply_jobs WHERE error_code = 'funnel_test_failure'
    `).get()).toEqual({ requestId: "funnel-failed-request" });
  });

  it("stops persisted automation when the selected provider is unavailable after restart", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    const sessionId = requireSessionId(database);
    repository.setReplyProvider(sessionId, "funnel", "job-42", Date.now());
    const session = repository.getSession(sessionId);
    if (!session) throw new Error("missing test session");
    expect(session.automationEnabled).toBe(true);
    const queuedItem = fakeDm("queued-before-provider-restart", "finder-1", "仍在排队");
    const inboundId = "queued-before-provider-restart-inbound";
    repository.insertInbound({
      id: inboundId,
      sessionId,
      source: "dm",
      externalIdHash: secureStore.keyedHash(
        queuedItem.externalId,
        `inbound:${sessionId}:dm`,
      ),
      payloadEnvelope: secureStore.encryptJson(
        queuedItem,
        sessionId,
        `inbound:${inboundId}`,
      ),
      occurredAt: queuedItem.occurredAt,
      discoveredAt: Date.now(),
      historical: false,
      replyEligible: true,
      authGeneration: session.authGeneration,
      runGeneration: session.runGeneration,
      platformClientId: "queued-before-provider-restart-client",
    });
    expect(database?.prepare(
      "SELECT state FROM reply_jobs WHERE inbound_item_id = ?",
    ).get(inboundId)).toEqual({ state: "queued" });

    const restarted = new SessionService(
      testConfig(),
      repository,
      secureStore,
      gateway,
    );
    expect(restarted.reconcileProviderAvailability()).toBe(1);

    expect(await snapshot(server, visitor.cookie)).toMatchObject({
      authState: "stopped",
      automationEnabled: false,
      replyProvider: "funnel",
      funnelJobNumber: "job-42",
      service: { selectedProviderConfigured: false },
    });
    expect(database?.prepare(`
      SELECT state, error_code AS errorCode
      FROM reply_jobs WHERE inbound_item_id = ?
    `).get(inboundId)).toEqual({
      state: "failed",
      errorCode: "provider_unavailable_on_restart",
    });
  });

  it("does not replay a multi-bubble reply after a partial send failure", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();
    repository.setReplyProvider(
      requireSessionId(database),
      "funnel",
      "job-42",
      Date.now(),
    );
    funnelModel.result = {
      text: "第一条\n第二条",
      messages: ["第一条", "第二条"],
      disposition: "reply",
      model: "funnel",
    };
    gateway.sendErrors = [
      null,
      new WechatApiError("second_bubble_rejected", "dmSendText", false),
    ];
    gateway.newItems.set("finder-1", [
      fakeDm("funnel-partial-1", "finder-1", "分两条回复"),
    ]);

    await workers.runOnce();

    expect(gateway.sends.map((send) => send.text)).toEqual(["第一条", "第二条"]);
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "分两条回复")).toMatchObject({
        replyState: "submitted_unknown",
        replyErrorCode: "second_bubble_rejected",
      });
    await workers.runOnce();
    expect(gateway.sends).toHaveLength(2);
    expect(funnelModel.calls).toHaveLength(1);
  });

  it("does not retry an irreversible send with an ambiguous outcome", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    gateway.newItems.set("finder-1", [
      fakeDm("ambiguous-send", "finder-1", "这条回复是否发出？"),
    ]);
    gateway.sendError = new WechatApiError("timeout", "dmSendText", true);
    await workers.runOnce();

    const first = await snapshot(server, visitor.cookie);
    expect(first.timeline.find((item) => item.text === "这条回复是否发出？")).toMatchObject({
      replyState: "submitted_unknown",
      replyErrorCode: "timeout",
    });
    expect(gateway.sends).toHaveLength(1);
    expect(model.calls).toHaveLength(1);

    await workers.runOnce();
    expect(gateway.sends).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
  });

  it("keeps every paginated baseline item historical past the per-tick page cap", async () => {
    const server = requireApp(app);
    gateway.historyPagesRemaining = 12;
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);

    await workers.runOnce();
    const partial = await snapshot(server, visitor.cookie);
    expect(partial.authState).toBe("baseline_sync");
    expect(partial.timeline).toHaveLength(10);
    expect(partial.timeline.every((item) => item.historical && item.replyState === null)).toBe(true);

    await workers.runOnce();
    const complete = await snapshot(server, visitor.cookie);
    expect(complete.authState).toBe("active");
    expect(complete.timeline).toHaveLength(12);
    expect(complete.timeline.every((item) => item.historical && item.replyState === null)).toBe(true);
    expect(gateway.sends).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it("rejects an old account sync result after the visitor refreshes login", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    gateway.newItems.set("finder-1", [
      fakeDm("stale-account-item", "finder-1", "旧账号在途消息"),
    ]);
    const gate = gateway.blockNextDmSync();
    const staleRun = workers.runOnce();
    await gate.started;
    await startLogin(server, visitor.cookie);
    gate.release();
    await staleRun;

    const refreshed = await snapshot(server, visitor.cookie);
    expect(refreshed.authState).toBe("qr_pending");
    expect(refreshed.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(refreshed.timeline).toHaveLength(0);
  });

  it("rechecks stop authority immediately before platform dispatch", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    gateway.newItems.set("finder-1", [
      fakeDm("stop-before-dispatch", "finder-1", "请不要在停止后发送"),
    ]);
    const gate = gateway.blockNextSend();
    const pendingRun = workers.runOnce();
    await gate.started;
    const stopped = await server.inject({
      method: "POST",
      url: "/api/session/automation",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: { enabled: false },
    });
    expect(stopped.statusCode).toBe(200);
    gate.release();
    await pendingRun;

    const final = await snapshot(server, visitor.cookie);
    expect(final.authState).toBe("stopped");
    expect(final.timeline.find((item) => item.text === "请不要在停止后发送"))
      .toMatchObject({
        replyState: "failed",
        replyErrorCode: "dispatch_not_authorized",
      });
    expect(gateway.sends).toHaveLength(0);
  });

  it("serializes platform I/O so sync and send retain both CookieJar updates", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const sessionId = requireSessionId(database);
    const session = repository.getSession(sessionId);
    if (!session) throw new Error("missing test session");
    const item = fakeDm("cookie-race", "finder-1", "并发 Cookie 测试");
    const inboundId = "cookie-race-inbound";
    repository.insertInbound({
      id: inboundId,
      sessionId,
      source: "dm",
      externalIdHash: secureStore.keyedHash(item.externalId, `inbound:${sessionId}:dm`),
      payloadEnvelope: secureStore.encryptJson(item, sessionId, `inbound:${inboundId}`),
      occurredAt: item.occurredAt,
      discoveredAt: Date.now(),
      historical: false,
      replyEligible: true,
      authGeneration: session.authGeneration,
      runGeneration: session.runGeneration,
      platformClientId: "cookie-race-client",
    });

    const syncGate = gateway.blockNextDmSync();
    const syncRun = workers.runOnce();
    await syncGate.started;
    const replyRun = workers.runOnce();
    await expect.poll(() => model.calls.length).toBe(1);
    expect(gateway.sends).toHaveLength(0);
    syncGate.release();
    await Promise.all([syncRun, replyRun]);

    const envelope = repository.getCredentialEnvelope(sessionId);
    if (!envelope) throw new Error("missing credential envelope");
    const stored = secureStore.decryptJson<StoredCredential>(
      envelope,
      sessionId,
      "credentials",
    );
    if (stored.kind !== "session") throw new Error("unexpected credential kind");
    const cookies = CookieJar.deserializeSync(stored.value.cookieJar)
      .getCookiesSync("https://channels.weixin.qq.com/")
      .map((cookie) => cookie.key);
    expect(cookies).toEqual(expect.arrayContaining(["sync_refresh", "send_refresh"]));
    expect(gateway.sends).toHaveLength(1);
  });

  it("preserves an in-flight platform send outcome before QR refresh or logout", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    gateway.newItems.set("finder-1", [
      fakeDm("refresh-during-send", "finder-1", "发送过程中刷新"),
    ]);
    const gate = gateway.blockNextSendAfterDispatch();
    const pendingRun = workers.runOnce();
    await gate.started;

    const refresh = await server.inject({
      method: "POST",
      url: "/api/session/login",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
      payload: {},
    });
    expect(refresh.statusCode).toBe(409);
    expect(refresh.json()).toEqual({ error: "platform_send_in_flight" });
    const logout = await server.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie: visitor.cookie, origin: "http://localhost:4310" },
    });
    expect(logout.statusCode).toBe(409);

    gate.release();
    await pendingRun;
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((entry) => entry.text === "发送过程中刷新"))
      .toMatchObject({ replyState: "confirmed" });

    await startLogin(server, visitor.cookie);
    expect((await snapshot(server, visitor.cookie)).authState).toBe("qr_pending");
  });

  it("keeps an authenticated account active after its former local deadline", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const sessionId = requireSessionId(database);
    database?.prepare("UPDATE demo_sessions SET expires_at = 0 WHERE id = ?")
      .run(sessionId);
    gateway.newItems.set("finder-1", [
      fakeDm("after-former-deadline", "finder-1", "超过八小时后仍然回复"),
    ]);
    await workers.runOnce();

    const retained = repository.getSession(sessionId);
    expect(retained?.platformPersistent).toBe(true);
    const current = await snapshot(server, visitor.cookie);
    expect(current.authState).toBe("active");
    expect(current).not.toHaveProperty("expiresAt");
    expect(current.timeline.find((item) => item.text === "超过八小时后仍然回复"))
      .toMatchObject({
        replyState: "confirmed",
        replyText: "您好，已收到：超过八小时后仍然回复",
      });

    const shared = await server.inject({ method: "GET", url: "/api/sessions" });
    expect(shared.statusCode).toBe(200);
    expect(shared.json<{ sessions: unknown[] }>().sessions[0])
      .not.toHaveProperty("expiresAt");
  });

  it("re-baselines the observed comment cursor failure without replying to recovered history", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const sessionId = requireSessionId(database);
    const session = repository.getSession(sessionId);
    if (!session) throw new Error("missing test session");
    const retained = fakeComment("retained-before-recovery", "已经保留的评论");
    const retainedInboundId = "retained-before-recovery-inbound";
    repository.insertInbound({
      id: retainedInboundId,
      sessionId,
      source: "comment",
      externalIdHash: secureStore.keyedHash(
        retained.externalId,
        `inbound:${sessionId}:comment`,
      ),
      payloadEnvelope: secureStore.encryptJson(
        retained,
        sessionId,
        `inbound:${retainedInboundId}`,
      ),
      occurredAt: retained.occurredAt,
      discoveredAt: Date.now(),
      historical: true,
      replyEligible: false,
      authGeneration: session.authGeneration,
      runGeneration: session.runGeneration,
      platformClientId: "retained-before-recovery-client",
    });
    const legacyCursor = JSON.stringify({
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: "old-object",
      postExportId: "old-export",
      postSnapshot: [{ objectId: "old-object", exportId: "old-export" }],
      postPageHasMore: false,
    });
    const legacyCursorEnvelope = secureStore.encryptJson(
      legacyCursor,
      sessionId,
      "cursor:comment",
    );
    database?.prepare(`
      UPDATE source_states
      SET state = 'schema_changed', baseline_complete = 1,
          cursor_envelope = ?,
          last_error_code = 'schema_changed:post.cursor_target_missing',
          updated_at = ?
      WHERE session_id = ? AND source = 'comment'
    `).run(legacyCursorEnvelope, Date.now(), sessionId);
    gateway.newComments.set("finder-1", [
      // Old content carries a pre-login timestamp: the anchor, not the recovery scan itself, is
      // what keeps it historical.
      fakeComment("found-during-recovery", "恢复时发现的旧评论", Date.now() - 120_000),
    ]);

    await workers.runOnce();

    expect(repository.getSource(sessionId, "comment")).toMatchObject({
      state: "healthy",
      baselineComplete: true,
      lastErrorCode: null,
    });
    const recoveredRows = database?.prepare(`
      SELECT historical, reply_eligible AS replyEligible
      FROM inbound_items
      WHERE session_id = ? AND source = 'comment'
      ORDER BY discovered_at, id
    `).all(sessionId) as Array<{ historical: number; replyEligible: number }>;
    expect(recoveredRows).toHaveLength(2);
    expect(recoveredRows).toEqual([
      { historical: 1, replyEligible: 0 },
      { historical: 1, replyEligible: 0 },
    ]);
    expect(database?.prepare(
      "SELECT COUNT(*) AS value FROM reply_jobs WHERE session_id = ?",
    ).get(sessionId)).toEqual({ value: 0 });
    expect(model.calls).toHaveLength(0);
    expect(gateway.sends).toHaveLength(0);

    gateway.newComments.set("finder-1", [
      fakeComment("new-after-recovery", "恢复完成后的新评论"),
    ]);
    await workers.runOnce();
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "恢复完成后的新评论"))
      .toMatchObject({ historical: false, replyState: "confirmed" });
    expect(model.calls).toHaveLength(1);
    expect(gateway.sends).toHaveLength(1);

    database?.prepare(`
      UPDATE source_states
      SET state = 'schema_changed',
          last_error_code = 'schema_changed:comment.commentId',
          updated_at = ?
      WHERE session_id = ? AND source = 'comment'
    `).run(Date.now(), sessionId);
    const commentCallsBefore = gateway.commentSyncCalls;
    gateway.newComments.set("finder-1", [
      fakeComment("recovers-without-rescan", "结构异常退避后恢复"),
    ]);

    await workers.runOnce();

    // An unrelated schema error no longer ends the lane. It keeps its cursor and baseline, waits
    // out the schema backoff, and resumes on the next attempt — the direct-message incident showed
    // that a terminal state here turns one bad response into an outage only a rescan can clear.
    expect(gateway.commentSyncCalls).toBe(commentCallsBefore + 1);
    expect(repository.getSource(sessionId, "comment")).toMatchObject({
      state: "healthy",
      baselineComplete: true,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    });
    expect((await snapshot(server, visitor.cookie)).timeline
      .some((item) => item.text === "结构异常退避后恢复")).toBe(true);
  });

  it("keeps the observed-post checkpoint durable across comment failure and an empty post list", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    const sessionId = requireSessionId(database);
    const session = repository.getSession(sessionId);
    const existingSource = repository.getSource(sessionId, "comment");
    if (!session || !existingSource) throw new Error("missing comment checkpoint fixture");
    expect(repository.updateSource(
      sessionId,
      session.authGeneration,
      "comment",
      {
        state: "pending",
        baselineComplete: false,
        cursorEnvelope: null,
        lastSuccessAt: existingSource.lastSuccessAt,
        lastErrorCode: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      },
      Date.now(),
    )).toBe(true);

    const observedCursor = JSON.stringify({ v: 3, observedPosts: true });
    gateway.commentObservationCursor = observedCursor;
    gateway.commentSyncError = new WechatApiError(
      "network_error",
      "commentList",
      false,
    );
    await workers.runOnce();

    const failedAfterObservation = repository.getSource(sessionId, "comment");
    if (!failedAfterObservation?.cursorEnvelope) {
      throw new Error("missing durable observed-post checkpoint");
    }
    expect(secureStore.decryptJson<string>(
      failedAfterObservation.cursorEnvelope,
      sessionId,
      "cursor:comment",
    )).toBe(observedCursor);
    expect(failedAfterObservation).toMatchObject({
      state: "error",
      baselineComplete: false,
      lastErrorCode: "network_error",
    });

    gateway.commentSyncError = new WechatApiError(
      "platform_post_list_empty",
      "postList",
      false,
    );
    // The first failure scheduled a backoff, so a forced tick alone would be skipped. Clearing the
    // pending delay is what "attempt again now" means once retries are paced; the pacing itself is
    // covered by its own tests rather than being silently bypassed here.
    clearRetryDelay(database, sessionId, "comment");
    await workers.runOnce();
    expect(repository.getSource(sessionId, "comment")).toMatchObject({
      state: "error",
      baselineComplete: false,
      lastErrorCode: "platform_post_list_empty",
    });

    gateway.commentSyncError = null;
    clearRetryDelay(database, sessionId, "comment");
    gateway.newComments.set("finder-1", [
      fakeComment(
        "historical-after-interrupted-baseline",
        "中断基线后的历史评论",
        Date.now() - 120_000,
      ),
    ]);
    await workers.runOnce();

    expect(repository.getSource(sessionId, "comment")).toMatchObject({
      state: "healthy",
      baselineComplete: true,
      lastErrorCode: null,
    });
    expect((await snapshot(server, visitor.cookie)).timeline
      .find((item) => item.text === "中断基线后的历史评论"))
      .toMatchObject({ historical: true, replyState: null });
    expect(database?.prepare(
      "SELECT COUNT(*) AS value FROM reply_jobs WHERE session_id = ?",
    ).get(sessionId)).toEqual({ value: 0 });
    expect(model.calls).toHaveLength(0);
    expect(gateway.sends).toHaveLength(0);
  });

  it("cleans an abandoned unauthenticated session after its transient deadline", async () => {
    const server = requireApp(app);
    await bootstrap(server);
    const sessionId = requireSessionId(database);
    database?.prepare("UPDATE demo_sessions SET expires_at = 0 WHERE id = ?")
      .run(sessionId);

    await workers.runOnce();

    expect(repository.getSession(sessionId)).toBeNull();
  });

  it("requests a fresh QR when synchronization explicitly rejects authorization", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    gateway.dmSyncError = new WechatApiError("auth_required", "dmNewMessages", false);
    await workers.runOnce();

    const current = await snapshot(server, visitor.cookie);
    expect(current).toMatchObject({
      authState: "auth_required",
      authErrorCode: "auth_required",
    });
    expect(repository.getSession(requireSessionId(database))?.platformPersistent)
      .toBe(true);
  });

  it("requests a fresh QR when an unambiguous send rejects authorization", async () => {
    const server = requireApp(app);
    const visitor = await bootstrap(server);
    await startLogin(server, visitor.cookie);
    await workers.runOnce();

    gateway.newItems.set("finder-1", [
      fakeDm("send-auth-required", "finder-1", "登录失效测试"),
    ]);
    gateway.sendError = new WechatApiError("auth_required", "dmSendText", false);
    await workers.runOnce();

    const current = await snapshot(server, visitor.cookie);
    expect(current).toMatchObject({
      authState: "auth_required",
      authErrorCode: "auth_required",
    });
    expect(current.timeline.find((item) => item.text === "登录失效测试"))
      .toMatchObject({
        replyState: "failed",
        replyErrorCode: "auth_required",
      });
  });

  it("deletes only the owning session on logout", async () => {
    const server = requireApp(app);
    const a = await bootstrap(server);
    const b = await bootstrap(server);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie: a.cookie, origin: "http://localhost:4310" },
    });
    expect(response.statusCode).toBe(204);
    expect((await snapshot(server, b.cookie)).authState).toBe("new");
    const missing = await server.inject({
      method: "POST",
      url: "/api/session/login",
      headers: { cookie: a.cookie, origin: "http://localhost:4310" },
      payload: {},
    });
    expect(missing.statusCode).toBe(401);
  });
});

async function bootstrap(app: FastifyInstance): Promise<{ cookie: string; snapshot: SessionSnapshot }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions/new",
    headers: { origin: "http://localhost:4310" },
    payload: {},
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const raw = cookies.find((value) => value.startsWith("wechat_demo_session="));
  if (!raw) throw new Error("missing set-cookie");
  return {
    cookie: raw.split(";", 1)[0] ?? "",
    snapshot: response.json<SessionSnapshot>(),
  };
}

async function startLogin(app: FastifyInstance, cookie: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/session/login",
    headers: { cookie, origin: "http://localhost:4310" },
    payload: {},
  });
  expect(response.statusCode).toBe(200);
}

async function configureAccountWechatQr(
  app: FastifyInstance,
  cookie: string,
): Promise<void> {
  const current = await snapshot(app, cookie);
  const response = await app.inject({
    method: "PUT",
    url: "/api/session/wechat-qr",
    headers: {
      cookie,
      origin: "http://localhost:4310",
      "x-demo-account-id": current.sessionId,
    },
    payload: { dataUrl: TEST_ACCOUNT_WECHAT_QR },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    accountId: current.sessionId,
    wechatQr: {
      configured: true,
      mimeType: "image/png",
    },
  });
}

async function snapshot(app: FastifyInstance, cookie: string): Promise<SessionSnapshot> {
  const response = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<SessionSnapshot>();
}

function requireApp(app: FastifyInstance | undefined): FastifyInstance {
  if (!app) throw new Error("test app was not created");
  return app;
}

/** Forces the next attempt of an already-failed source without waiting out its backoff. */
function clearRetryDelay(
  database: SqliteDatabase | undefined,
  sessionId: string,
  source: "dm" | "comment",
): void {
  const result = database?.prepare(
    "UPDATE source_states SET next_attempt_at = NULL WHERE session_id = ? AND source = ?",
  ).run(sessionId, source);
  if (!result || result.changes !== 1) {
    throw new Error("missing source row to clear the retry delay");
  }
}

function requireSessionId(database: SqliteDatabase | undefined): string {
  const row = database?.prepare("SELECT id FROM demo_sessions LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error("missing demo session");
  return row.id;
}

function requireLoginAnchor(database: SqliteDatabase | undefined, sessionId: string): number {
  const row = database?.prepare(
    "SELECT last_login_at AS value FROM demo_sessions WHERE id = ?",
  ).get(sessionId) as { value: number | null } | undefined;
  if (row?.value == null) throw new Error("missing login anchor");
  return row.value;
}

function responseCookie(
  header: string | string[] | undefined,
  name: string,
): string {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = values
    .map((value) => value.split(";", 1)[0] ?? "")
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`missing ${name} cookie`);
  return cookie;
}
