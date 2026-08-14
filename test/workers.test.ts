import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAccountWechatQrDataUrl,
  parseStoredAccountWechatQr,
  storedAccountWechatQr,
} from "../src/account-wechat-qr.js";
import { SecureStore } from "../src/crypto.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { DemoRepository } from "../src/repository.js";
import type { StoredCredential } from "../src/service/credentials.js";
import { WorkerCoordinator } from "../src/service/workers.js";
import type { SourceState } from "../src/types.js";
import { WechatApiError } from "../src/wechat/transport.js";
import {
  FakeReplyModel,
  FakeWechatGateway,
  fakeDm,
  fakePlatformSession,
  testConfig,
} from "./helpers.js";

describe("WorkerCoordinator scheduling", () => {
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close();
    database = undefined;
  });

  it("keeps direct messages configured and checks the durable comment due time every 5 seconds", async () => {
    const intervals: number[] = [];
    const handles: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      _handler: Parameters<typeof setInterval>[0],
      timeout: Parameters<typeof setInterval>[1],
    ) => {
      const handle = {
        unref: () => handle,
      } as unknown as NodeJS.Timeout;
      intervals.push(Number(timeout));
      handles.push(handle);
      return handle;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const config = testConfig({
      loginPollMs: 11_000,
      syncPollMs: 15_000,
      workerPollMs: 17_000,
      cleanupPollMs: 19_000,
    });
    database = openDatabase(":memory:");
    const workers = new WorkerCoordinator(
      config,
      new DemoRepository(database),
      new SecureStore(config.encryptionKey),
      new FakeWechatGateway(),
      {
        "chat-llm": new FakeReplyModel(),
        funnel: new FakeReplyModel(),
      },
    );

    workers.start();
    await workers.stop();

    expect(handles).toHaveLength(5);
    expect(intervals).toEqual([
      11_000,
      15_000,
      5_000,
      17_000,
      19_000,
    ]);
  });

  it.each([
    ["healthy", null],
    ["error", "platform_post_list_empty"],
  ] satisfies Array<[SourceState, string | null]>) (
    "does not repeat a %s account comment request within 60 seconds across restarts",
    async (state, errorCode) => {
      const config = testConfig();
      database = openDatabase(":memory:");
      const repository = new DemoRepository(database);
      const secureStore = new SecureStore(config.encryptionKey);
      const gateway = new FakeWechatGateway();
      const attemptedAt = 1_000_000;
      let now = attemptedAt;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      authenticateFixture(repository, secureStore, attemptedAt, {
        state,
        baselineComplete: true,
        errorCode,
      });
      const completedSource = repository.getSource("session-1", "comment");
      if (!completedSource) throw new Error("missing completed comment source");
      repository.updateSource(
        "session-1",
        0,
        "comment",
        {
          state,
          baselineComplete: true,
          cursorEnvelope: completedSource.cursorEnvelope,
          lastSuccessAt: attemptedAt + 1_000,
          lastErrorCode: errorCode,
          consecutiveFailures: 0,
          nextAttemptAt: null,
        },
        attemptedAt + 1_000,
      );

      now = attemptedAt + 59_999;
      const beforeDue = createWorkers(config, repository, secureStore, gateway);
      beforeDue.start();
      await beforeDue.stop();
      expect(gateway.commentSyncCalls).toBe(0);

      now = attemptedAt + 60_000;
      const whenDue = createWorkers(config, repository, secureStore, gateway);
      whenDue.start();
      await whenDue.stop();
      expect(gateway.commentSyncCalls).toBe(1);
    },
  );

  it("does not repeat a comment sweep within 90 seconds across restarts", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const anchoredAt = 1_000_000;
    let now = anchoredAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    authenticateFixture(repository, secureStore, anchoredAt, {
      state: "healthy",
      baselineComplete: true,
      errorCode: null,
    });

    // The fast lane was just attempted, so only the sweep is eligible on this tick.
    const first = createWorkers(config, repository, secureStore, gateway);
    first.start();
    await first.stop();
    expect(gateway.commentSyncCalls).toBe(0);
    expect(gateway.sweepCalls).toEqual([4]);

    now = anchoredAt + 89_999;
    const beforeDue = createWorkers(config, repository, secureStore, gateway);
    beforeDue.start();
    await beforeDue.stop();
    expect(gateway.sweepCalls).toEqual([4]);

    now = anchoredAt + 90_000;
    const whenDue = createWorkers(config, repository, secureStore, gateway);
    whenDue.start();
    await whenDue.stop();
    expect(gateway.sweepCalls).toEqual([4, 5]);
  });

  it("advances the sweep rank and wraps at the bound and at a short feed", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const anchoredAt = 1_000_000;
    let now = anchoredAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    authenticateFixture(repository, secureStore, anchoredAt, {
      state: "healthy",
      baselineComplete: true,
      errorCode: null,
    });

    const runOnce = async (): Promise<void> => {
      const workers = createWorkers(config, repository, secureStore, gateway);
      workers.start();
      await workers.stop();
    };

    await runOnce();
    expect(repository.getSource("session-1", "comment")).toMatchObject({ sweepRank: 5 });

    // The last swept rank wraps back to the first.
    expect(repository.advanceCommentSweep("session-1", 0, 100, now)).toBe(true);
    now = anchoredAt + 90_000;
    await runOnce();
    expect(repository.getSource("session-1", "comment")).toMatchObject({ sweepRank: 4 });

    // A feed that ends before the target rank wraps without advancing past it.
    expect(repository.advanceCommentSweep("session-1", 0, 42, now)).toBe(true);
    gateway.sweepWrappedRanks.add(42);
    now = anchoredAt + 180_000;
    await runOnce();
    expect(repository.getSource("session-1", "comment")).toMatchObject({ sweepRank: 4 });
    expect(gateway.sweepCalls).toEqual([4, 100, 42]);
  });

  it("routes a sweep failure through the shared comment backoff", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const anchoredAt = 1_000_000;
    let now = anchoredAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    authenticateFixture(repository, secureStore, anchoredAt, {
      state: "healthy",
      baselineComplete: true,
      errorCode: null,
    });

    gateway.sweepError = new WechatApiError("network_error", "postList", false);
    const failing = createWorkers(config, repository, secureStore, gateway);
    failing.start();
    await failing.stop();
    expect(gateway.sweepCalls).toEqual([4]);
    expect(repository.getSource("session-1", "comment")).toMatchObject({
      state: "error",
      lastErrorCode: "network_error",
      consecutiveFailures: 1,
      nextAttemptAt: anchoredAt + 60_000,
      sweepRank: null,
    });

    // Both lanes wait out the same persisted schedule.
    gateway.sweepError = null;
    now = anchoredAt + 30_000;
    const backedOff = createWorkers(config, repository, secureStore, gateway);
    backedOff.start();
    await backedOff.stop();
    expect(gateway.commentSyncCalls).toBe(0);
    expect(gateway.sweepCalls).toEqual([4]);

    // The fast scan recovers the lane; the unadvanced rank is retried on the next due sweep.
    now = anchoredAt + 90_000;
    const recovered = createWorkers(config, repository, secureStore, gateway);
    recovered.start();
    await recovered.stop();
    expect(gateway.commentSyncCalls).toBe(1);
    expect(gateway.sweepCalls).toEqual([4, 4]);
    expect(repository.getSource("session-1", "comment")).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
      sweepRank: 5,
    });
  });

  it("runs a pending incomplete comment baseline immediately", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const now = 2_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    authenticateFixture(repository, secureStore, now, {
      state: "pending",
      baselineComplete: false,
      errorCode: null,
      cursorPresent: false,
    });

    const workers = createWorkers(config, repository, secureStore, gateway);
    workers.start();
    await workers.stop();

    expect(gateway.commentSyncCalls).toBe(1);
    expect(repository.getSource("session-1", "comment")).toMatchObject({
      state: "healthy",
      baselineComplete: true,
    });
  });

  it("treats a completed legacy null comment cursor as previously observed", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const now = 2_100_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    authenticateFixture(repository, secureStore, now, {
      state: "healthy",
      baselineComplete: true,
      errorCode: null,
      cursorPresent: false,
    });

    const workers = createWorkers(config, repository, secureStore, gateway);
    workers.start();
    await workers.stop();

    expect(gateway.commentCursors).toHaveLength(1);
    expect(JSON.parse(gateway.commentCursors[0] ?? "null")).toEqual({
      v: 3,
      observedPosts: true,
    });
  });

  it("persists a comment attempt before the platform request completes", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const initializedAt = 2_200_000;
    const attemptedAt = 2_250_000;
    let now = attemptedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    authenticateFixture(repository, secureStore, initializedAt, {
      state: "pending",
      baselineComplete: false,
      errorCode: null,
      cursorPresent: false,
    });
    const requestGate = gateway.blockNextCommentSync();
    const firstProcess = createWorkers(config, repository, secureStore, gateway);
    firstProcess.start();
    await requestGate.started;

    expect(repository.getSource("session-1", "comment")).toMatchObject({
      state: "pending",
      baselineComplete: false,
      lastAttemptAt: attemptedAt,
      updatedAt: attemptedAt,
    });
    expect(repository.getSource("session-1", "comment")?.cursorEnvelope).not.toBeNull();

    now = attemptedAt + 59_999;
    const restartedProcess = createWorkers(config, repository, secureStore, gateway);
    restartedProcess.start();
    await restartedProcess.stop();
    expect(gateway.commentSyncCalls).toBe(1);

    requestGate.release();
    await firstProcess.stop();
  });

  it("waits 60 seconds before resuming a checkpointed pending baseline", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const checkpointedAt = 2_500_000;
    let now = checkpointedAt + 59_999;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    authenticateFixture(repository, secureStore, checkpointedAt, {
      state: "pending",
      baselineComplete: false,
      errorCode: null,
      cursorPresent: true,
    });

    const beforeDue = createWorkers(config, repository, secureStore, gateway);
    beforeDue.start();
    await beforeDue.stop();
    expect(gateway.commentSyncCalls).toBe(0);

    now = checkpointedAt + 60_000;
    const whenDue = createWorkers(config, repository, secureStore, gateway);
    whenDue.start();
    await whenDue.stop();
    expect(gateway.commentSyncCalls).toBe(1);
  });

  it("recovers the exact legacy comment cursor and re-baselines immediately", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const now = 3_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    authenticateFixture(repository, secureStore, now, {
      state: "schema_changed",
      baselineComplete: true,
      errorCode: "schema_changed:post.cursor_target_missing",
    });

    const workers = createWorkers(config, repository, secureStore, gateway);
    workers.start();
    await workers.stop();

    expect(gateway.commentSyncCalls).toBe(1);
    expect(repository.getSource("session-1", "comment")).toMatchObject({
      state: "healthy",
      baselineComplete: true,
      lastErrorCode: null,
    });
  });

  it("does not mutate comment attempt or recovery state for a stale auth generation", () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const now = 3_500_000;
    authenticateFixture(repository, secureStore, now, {
      state: "schema_changed",
      baselineComplete: true,
      errorCode: "schema_changed:post.cursor_target_missing",
    });
    const before = repository.getSource("session-1", "comment");
    if (!before) throw new Error("missing stale-generation fixture");
    const replacementCursor = secureStore.encryptJson(
      JSON.stringify({ v: 3, observedPosts: true }),
      "session-1",
      "cursor:comment",
    );

    expect(repository.markCommentSyncAttempt(
      "session-1",
      1,
      replacementCursor,
      now + 1,
    )).toBeNull();
    expect(repository.recoverCommentCursorTargetMissing(
      "session-1",
      1,
      now + 1,
    )).toBeNull();
    expect(repository.getSource("session-1", "comment")).toEqual(before);
  });

  it("keeps runOnce as an explicit immediate comment sync", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    const now = 4_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    authenticateFixture(repository, secureStore, now, {
      state: "healthy",
      baselineComplete: true,
      errorCode: null,
    });

    const workers = createWorkers(config, repository, secureStore, gateway);
    await workers.runOnce();

    expect(gateway.commentSyncCalls).toBe(1);
  });
});

describe("WorkerCoordinator source retry pacing", () => {
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close();
    database = undefined;
  });

  function dmFixture(now: number) {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    vi.spyOn(Date, "now").mockReturnValue(now);
    authenticateFixture(repository, secureStore, now, {
      state: "healthy",
      baselineComplete: true,
      errorCode: null,
    });
    return { config, repository, secureStore, gateway };
  }

  function dmSource(repository: DemoRepository) {
    const source = repository.getSource("session-1", "dm");
    if (!source) throw new Error("missing dm source");
    return source;
  }

  it("schedules a retry for a transient direct-message failure and clears it on success", async () => {
    const start = 5_000_000;
    const { config, repository, secureStore, gateway } = dmFixture(start);
    gateway.dmSyncError = new WechatApiError("dm_cursor_unavailable", "dmLoginCookie", false);
    const workers = createWorkers(config, repository, secureStore, gateway);

    await workers.runOnce();
    expect(dmSource(repository)).toMatchObject({
      state: "error",
      lastErrorCode: "dm_cursor_unavailable",
      consecutiveFailures: 1,
      nextAttemptAt: start + config.syncPollMs,
    });

    vi.spyOn(Date, "now").mockReturnValue(start + config.syncPollMs - 1);
    await workers.runOnce();
    expect(dmSource(repository).consecutiveFailures).toBe(1);

    gateway.dmSyncError = null;
    vi.spyOn(Date, "now").mockReturnValue(start + config.syncPollMs);
    await workers.runOnce();
    expect(dmSource(repository)).toMatchObject({
      state: "healthy",
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    });
  });

  it("doubles the direct-message retry delay per consecutive failure and stops at the cap", async () => {
    const start = 6_000_000;
    const { config, repository, secureStore, gateway } = dmFixture(start);
    gateway.dmSyncError = new WechatApiError("network_error", "dmHistory", false);
    const workers = createWorkers(config, repository, secureStore, gateway);

    const delays: number[] = [];
    let clock = start;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      vi.spyOn(Date, "now").mockReturnValue(clock);
      await workers.runOnce();
      const source = dmSource(repository);
      if (source.nextAttemptAt === null) throw new Error("missing scheduled retry");
      delays.push(source.nextAttemptAt - clock);
      clock = source.nextAttemptAt;
    }
    expect(delays).toEqual([
      config.syncPollMs,
      config.syncPollMs * 2,
      config.syncPollMs * 4,
      config.syncPollMs * 8,
    ]);

    for (let attempt = 0; attempt < 24; attempt += 1) {
      vi.spyOn(Date, "now").mockReturnValue(clock);
      await workers.runOnce();
      const source = dmSource(repository);
      if (source.nextAttemptAt === null) throw new Error("missing scheduled retry");
      clock = source.nextAttemptAt;
    }
    const capped = dmSource(repository);
    if (capped.nextAttemptAt === null) throw new Error("missing scheduled retry");
    expect(capped.nextAttemptAt - capped.updatedAt).toBe(1_800_000);
  });

  it("retries a direct-message schema change after its slower floor without a fresh scan", async () => {
    const start = 7_000_000;
    const { config, repository, secureStore, gateway } = dmFixture(start);
    gateway.dmSyncError = new WechatApiError("schema_changed:data.msg", "dmHistory", false);
    const workers = createWorkers(config, repository, secureStore, gateway);

    await workers.runOnce();
    expect(dmSource(repository)).toMatchObject({
      state: "schema_changed",
      lastErrorCode: "schema_changed:data.msg",
      nextAttemptAt: start + 300_000,
    });

    // The lane used to end here for the life of the credential. It must resume by itself.
    gateway.dmSyncError = null;
    vi.spyOn(Date, "now").mockReturnValue(start + 300_000);
    await workers.runOnce();
    expect(dmSource(repository)).toMatchObject({
      state: "healthy",
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    });
    const session = repository.getSession("session-1");
    expect(session?.authGeneration).toBe(0);
  });

  it("honors a persisted retry delay across a restart", async () => {
    const start = 8_000_000;
    const { config, repository, secureStore, gateway } = dmFixture(start);
    gateway.dmSyncError = new WechatApiError("network_error", "dmHistory", false);
    await createWorkers(config, repository, secureStore, gateway).runOnce();
    expect(dmSource(repository).consecutiveFailures).toBe(1);

    gateway.dmSyncError = null;
    vi.spyOn(Date, "now").mockReturnValue(start + config.syncPollMs - 1);
    const restarted = createWorkers(config, repository, secureStore, gateway);
    await restarted.runOnce();
    expect(dmSource(repository)).toMatchObject({
      state: "error",
      consecutiveFailures: 1,
    });

    vi.spyOn(Date, "now").mockReturnValue(start + config.syncPollMs);
    await restarted.runOnce();
    expect(dmSource(repository).state).toBe("healthy");
  });
});

describe("WorkerCoordinator re-login takeover", () => {
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close();
    database = undefined;
  });

  it("retires the previous container and hands its account over to the new login", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    gateway.accountName = "finder-takeover";
    const workers = createWorkers(config, repository, secureStore, gateway);

    await beginLogin(repository, secureStore, gateway, config, "container-old");
    await workers.runOnce();
    const oldRow = repository.getSession("container-old");
    if (!oldRow?.accountKeyHash) throw new Error("old container did not authenticate");

    repository.setReplyProvider("container-old", "funnel", "JOB-1234", Date.now());
    const qr = parseAccountWechatQrDataUrl(TEST_QR_DATA_URL);
    repository.upsertAccountQrAsset({
      sessionId: "container-old",
      envelope: secureStore.encryptJson(
        storedAccountWechatQr(qr),
        "container-old",
        "account-wechat-qr",
      ),
      mimeType: qr.mimeType,
      byteLength: qr.bytes.byteLength,
      updatedAt: Date.now(),
    });
    const configured = repository.getSession("container-old");
    if (!configured) throw new Error("missing configured old container");
    const inserted = repository.insertInbound({
      id: "inbound-queued",
      accountKeyHash: oldRow.accountKeyHash,
      sessionId: "container-old",
      source: "dm",
      externalIdHash: "hash-queued",
      payloadEnvelope: secureStore.encryptJson(
        fakeDm("queued", "finder-takeover", "待回复"),
        "container-old",
        "inbound:inbound-queued",
      ),
      occurredAt: Date.now(),
      discoveredAt: Date.now(),
      historical: false,
      replyEligible: true,
      authGeneration: configured.authGeneration,
      runGeneration: configured.runGeneration,
      platformClientId: "client-queued",
    });
    expect(inserted.replyId).not.toBeNull();

    await beginLogin(repository, secureStore, gateway, config, "container-new");
    await workers.runOnce();

    const retired = repository.getSession("container-old");
    expect(retired).toMatchObject({
      authState: "logged_out",
      accountKeyHash: null,
      platformPersistent: false,
      lastErrorCode: "superseded_by_relogin",
      linkedSessionId: "container-new",
    });
    if (!retired) throw new Error("missing retired container");
    expect(retired.expiresAt).toBeLessThanOrEqual(Date.now() + config.pendingSessionTtlMs);
    expect(repository.getCredentialEnvelope("container-old")).toBeNull();
    expect(repository.getReplyForInbound("inbound-queued")).toMatchObject({
      state: "failed",
      errorCode: "account_superseded",
    });

    const successor = repository.getSession("container-new");
    expect(successor).toMatchObject({
      accountKeyHash: oldRow.accountKeyHash,
      platformPersistent: true,
      replyProvider: "funnel",
      funnelJobNumber: "JOB-1234",
    });
    const successorEnvelope = repository.getCredentialEnvelope("container-new");
    if (!successorEnvelope) throw new Error("missing successor credential");
    const credential = secureStore.decryptJson<StoredCredential>(
      successorEnvelope,
      "container-new",
      "credentials",
    );
    expect(credential.kind).toBe("session");

    const carried = repository.getAccountQrAsset("container-new");
    expect(carried).toMatchObject({
      mimeType: qr.mimeType,
      byteLength: qr.bytes.byteLength,
    });
    if (!carried) throw new Error("missing carried QR asset");
    const carriedStored = secureStore.decryptJson<unknown>(
      carried.envelope,
      "container-new",
      "account-wechat-qr",
    );
    expect(
      Buffer.from(parseStoredAccountWechatQr(carriedStored).bytes).equals(qr.bytes),
    ).toBe(true);
  });

  it("carries the account ledger across a takeover and never answers the overlap again", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    gateway.accountName = "finder-ledger";
    const workers = createWorkers(config, repository, secureStore, gateway);

    await beginLogin(repository, secureStore, gateway, config, "container-old");
    await workers.runOnce();
    const oldRow = repository.getSession("container-old");
    if (!oldRow?.accountKeyHash) throw new Error("old container did not authenticate");
    const accountKeyHash = oldRow.accountKeyHash;

    const crossItem = fakeDm("cross-container-dm", "finder-ledger", "跨容器消息");
    gateway.newItems.set("finder-ledger", [crossItem]);
    for (let round = 0; round < 3; round += 1) await workers.runOnce();
    expect(gateway.sends).toHaveLength(1);
    const answered = repository
      .listInbound(accountKeyHash)
      .filter((row) => row.sessionId === "container-old");
    expect(answered.length).toBeGreaterThanOrEqual(2);

    await beginLogin(repository, secureStore, gateway, config, "container-new");
    await workers.runOnce();
    const successor = repository.getSession("container-new");
    expect(successor?.accountKeyHash).toBe(accountKeyHash);

    // The platform re-offers the already-answered message to the new container.
    gateway.newItems.set("finder-ledger", [crossItem]);
    for (let round = 0; round < 3; round += 1) await workers.runOnce();

    expect(gateway.sends).toHaveLength(1);
    const copies = database
      .prepare("SELECT COUNT(*) AS count FROM inbound_items WHERE external_id_hash = ?")
      .get(secureStore.keyedHash(
        crossItem.externalId,
        `inbound:acct:${accountKeyHash}:dm`,
      )) as { count: number };
    expect(copies.count).toBe(1);
    // The successor's feed still shows the predecessor's row with its reply record.
    const answeredRow = answered.find((row) => !row.historical);
    if (!answeredRow) throw new Error("missing answered inbound row");
    const ledger = repository.listInbound(accountKeyHash);
    expect(ledger.map((row) => row.id)).toContain(answeredRow.id);
    expect(repository.getReplyForInbound(answeredRow.id)).toMatchObject({
      state: "confirmed",
      sessionId: "container-old",
    });
  });

  it("orphans and sweeps the previous account's history when a container rebinds", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    gateway.accountName = "finder-a";
    const workers = createWorkers(config, repository, secureStore, gateway);

    await beginLogin(repository, secureStore, gateway, config, "container-1");
    await workers.runOnce();
    const first = repository.getSession("container-1");
    if (!first?.accountKeyHash) throw new Error("container did not authenticate");
    const accountA = first.accountKeyHash;
    expect(repository.listInbound(accountA).length).toBeGreaterThan(0);

    // Re-scan the same container with a different WeChat account.
    gateway.accountName = "finder-b";
    const pending = await gateway.createLogin(config.qrTtlMs);
    repository.beginQr(
      "container-1",
      Date.now(),
      Date.now() + 3_600_000,
      secureStore.encryptJson(
        { kind: "pending", value: pending } satisfies StoredCredential,
        "container-1",
        "credentials",
      ),
    );
    // Mid-relogin the binding survives, so the ledger is not sweepable yet.
    expect(repository.getSession("container-1")?.accountKeyHash).toBe(accountA);
    expect(repository.deleteOrphanAccountHistory()).toBe(0);

    await workers.runOnce();
    const rebound = repository.getSession("container-1");
    if (!rebound?.accountKeyHash) throw new Error("container did not rebind");
    expect(rebound.accountKeyHash).not.toBe(accountA);
    // The old account lost its last container; runOnce's cleanup sweeps its history.
    expect(repository.listInbound(accountA)).toHaveLength(0);
  });

  it("removes the holder's account history when the container is deleted", async () => {
    const config = testConfig();
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const gateway = new FakeWechatGateway();
    gateway.accountName = "finder-gone";
    const workers = createWorkers(config, repository, secureStore, gateway);

    await beginLogin(repository, secureStore, gateway, config, "container-del");
    await workers.runOnce();
    const session = repository.getSession("container-del");
    if (!session?.accountKeyHash) throw new Error("container did not authenticate");
    expect(repository.listInbound(session.accountKeyHash).length).toBeGreaterThan(0);

    expect(repository.deleteSession("container-del")).toBe(true);
    expect(repository.listInbound(session.accountKeyHash)).toHaveLength(0);
  });
});

const TEST_QR_DATA_URL = `data:image/png;base64,${
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
}`;

async function beginLogin(
  repository: DemoRepository,
  secureStore: SecureStore,
  gateway: FakeWechatGateway,
  config: ReturnType<typeof testConfig>,
  sessionId: string,
): Promise<void> {
  const now = Date.now();
  repository.createSession(sessionId, now, now + 3_600_000, true);
  const pending = await gateway.createLogin(config.qrTtlMs);
  const envelope = secureStore.encryptJson(
    { kind: "pending", value: pending } satisfies StoredCredential,
    sessionId,
    "credentials",
  );
  repository.beginQr(sessionId, now, now + 3_600_000, envelope);
}

function createWorkers(
  config: ReturnType<typeof testConfig>,
  repository: DemoRepository,
  secureStore: SecureStore,
  gateway: FakeWechatGateway,
): WorkerCoordinator {
  return new WorkerCoordinator(
    config,
    repository,
    secureStore,
    gateway,
    {
      "chat-llm": new FakeReplyModel(),
      funnel: new FakeReplyModel(),
    },
  );
}

function authenticateFixture(
  repository: DemoRepository,
  secureStore: SecureStore,
  now: number,
  comment: {
    state: SourceState;
    baselineComplete: boolean;
    errorCode: string | null;
    cursorPresent?: boolean;
  },
): void {
  const sessionId = "session-1";
  const platformSession = fakePlatformSession("finder-1");
  repository.createSession(sessionId, now, now + 3_600_000, true);
  const credentialEnvelope = secureStore.encryptJson(
    { kind: "session", value: platformSession } satisfies StoredCredential,
    sessionId,
    "credentials",
  );
  if (!repository.completeAuthentication(
    sessionId,
    0,
    secureStore.keyedHash(platformSession.finderUsername, "finder-account"),
    credentialEnvelope,
    now,
  ).completed) throw new Error("failed to authenticate worker fixture");

  const dmCursorEnvelope = secureStore.encryptJson(
    "dm-cursor",
    sessionId,
    "cursor:dm",
  );
  repository.updateSource(
    sessionId,
    0,
    "dm",
    {
      state: "healthy",
      baselineComplete: true,
      cursorEnvelope: dmCursorEnvelope,
      lastSuccessAt: now,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    },
    now,
  );
  const commentCursorEnvelope = secureStore.encryptJson(
    "comment-cursor",
    sessionId,
    "cursor:comment",
  );
  repository.updateSource(
    sessionId,
    0,
    "comment",
    {
      state: comment.state,
      baselineComplete: comment.baselineComplete,
      cursorEnvelope: comment.cursorPresent === false ? null : commentCursorEnvelope,
      lastSuccessAt: comment.baselineComplete || comment.cursorPresent === true ? now : null,
      lastErrorCode: comment.errorCode,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    },
    now,
  );
  if (comment.cursorPresent !== false) {
    if (!repository.markCommentSyncAttempt(
      sessionId,
      0,
      commentCursorEnvelope,
      now,
    )) throw new Error("failed to mark comment attempt fixture");
  }
  repository.setSessionActiveIfBaselinesComplete(sessionId, 0, now);
}
