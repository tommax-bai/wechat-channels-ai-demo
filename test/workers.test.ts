import { afterEach, describe, expect, it, vi } from "vitest";
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
  )) throw new Error("failed to authenticate worker fixture");

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
