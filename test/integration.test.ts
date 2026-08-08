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
  const response = await app.inject({ method: "GET", url: "/api/session" });
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
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

function requireSessionId(database: SqliteDatabase | undefined): string {
  const row = database?.prepare("SELECT id FROM demo_sessions LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error("missing demo session");
  return row.id;
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
