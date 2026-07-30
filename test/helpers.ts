import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SerializedCookieJar } from "tough-cookie";
import { CookieJar } from "tough-cookie";
import type { AppConfig } from "../src/config.js";
import type { ReplyModel } from "../src/model/reply-model.js";
import type {
  NormalizedInboundItem,
  PlatformSession,
  ReplyModelInput,
  ReplyModelResult,
  ReplyTarget,
} from "../src/types.js";
import type {
  LoginPollResult,
  PendingWechatLogin,
  WechatGateway,
  WechatSendResult,
  WechatSyncPage,
} from "../src/wechat/client.js";
import { WechatApiError } from "../src/wechat/transport.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 4310,
    publicOrigin: "http://localhost:4310",
    databasePath: ":memory:",
    sessionCookieName: "wechat_demo_session",
    sessionCookieSecure: false,
    encryptionKey: Buffer.alloc(32, 7),
    sessionTtlMs: 60 * 60 * 1_000,
    qrTtlMs: 4 * 60 * 1_000,
    loginPollMs: 10,
    syncPollMs: 10,
    workerPollMs: 10,
    workerConcurrency: 4,
    cleanupPollMs: 10,
    maxActiveSessions: 100,
    maxResponseBytes: 2 * 1_024 * 1_024,
    wechatBaseUrl: "https://channels.weixin.qq.com",
    wechatTimeoutMs: 1_000,
    autoReplyEnabled: true,
    arkApiKey: "test-key",
    arkBaseUrl: "https://ark.example.test/api/v3",
    arkModel: "doubao-seed-character-260628",
    arkTimeoutMs: 1_000,
    ...overrides,
  };
}

export function temporaryDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "wechat-channels-demo-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export class FakeReplyModel implements ReplyModel {
  readonly calls: ReplyModelInput[] = [];

  async generate(input: ReplyModelInput): Promise<ReplyModelResult> {
    this.calls.push(input);
    return {
      text: `您好，已收到：${input.text}`,
      model: "doubao-seed-character-260628",
      requestId: "fake-request",
    };
  }
}

export class FakeWechatGateway implements WechatGateway {
  readonly sends: Array<{ session: PlatformSession; target: ReplyTarget; text: string; clientId: string }> = [];
  readonly newItems = new Map<string, NormalizedInboundItem[]>();
  accountName: string | null = null;
  sendError: WechatApiError | null = null;
  historyPagesRemaining = 1;
  private readonly tokenAccounts = new Map<string, string>();
  private dmGate: AsyncGate | null = null;
  private sendGate: AsyncGate | null = null;
  private sendAfterDispatchGate: AsyncGate | null = null;
  private historySequence = 0;
  private sequence = 0;

  async createLogin(qrTtlMs: number): Promise<PendingWechatLogin> {
    this.sequence += 1;
    const token = `token-${this.sequence}`;
    this.tokenAccounts.set(token, this.accountName ?? `finder-${this.sequence}`);
    const now = Date.now();
    return {
      token,
      cookieJar: serializeJar(new CookieJar()),
      issuedAt: now,
      expiresAt: now + qrTtlMs,
    };
  }

  async pollLogin(pending: PendingWechatLogin): Promise<LoginPollResult> {
    const finderUsername = this.tokenAccounts.get(pending.token) ?? "finder-unknown";
    return {
      state: "confirmed",
      session: fakePlatformSession(finderUsername),
    };
  }

  async syncDirectMessages(session: PlatformSession, cursor: string | null): Promise<WechatSyncPage> {
    const gate = this.dmGate;
    if (gate) {
      this.dmGate = null;
      gate.markStarted();
      await gate.wait;
    }
    setSessionCookie(session, "sync_refresh", "1");
    if (cursor === null || cursor.startsWith("history-")) {
      this.historyPagesRemaining = Math.max(0, this.historyPagesRemaining - 1);
      this.historySequence += 1;
      const hasMore = this.historyPagesRemaining > 0;
      return {
        items: [fakeDm(
          `history-${session.finderUsername}-${this.historySequence}`,
          session.finderUsername,
          "历史消息",
        )],
        cursor: hasMore ? `history-${this.historyPagesRemaining}` : "cursor-1",
        hasMore,
      };
    }
    const items = this.newItems.get(session.finderUsername) ?? [];
    this.newItems.set(session.finderUsername, []);
    return { items, cursor: `cursor-${Date.now()}`, hasMore: false };
  }

  async syncComments(): Promise<WechatSyncPage> {
    return { items: [], cursor: null, hasMore: false };
  }

  async sendReply(
    session: PlatformSession,
    target: ReplyTarget,
    text: string,
    clientId: string,
    beforeDispatch?: () => boolean,
  ): Promise<WechatSendResult> {
    const gate = this.sendGate;
    if (gate) {
      this.sendGate = null;
      gate.markStarted();
      await gate.wait;
    }
    if (beforeDispatch && !beforeDispatch()) {
      throw new WechatApiError(
        "dispatch_not_authorized",
        target.kind === "dm" ? "dmSendText" : "commentCreate",
        false,
      );
    }
    this.sends.push({ session, target, text, clientId });
    setSessionCookie(session, "send_refresh", "1");
    const afterDispatchGate = this.sendAfterDispatchGate;
    if (afterDispatchGate) {
      this.sendAfterDispatchGate = null;
      afterDispatchGate.markStarted();
      await afterDispatchGate.wait;
    }
    if (this.sendError) throw this.sendError;
    return { accepted: true, externalId: `sent-${this.sends.length}` };
  }

  blockNextDmSync(): GateHandle {
    const gate = createGate();
    this.dmGate = gate.internal;
    return gate.handle;
  }

  blockNextSend(): GateHandle {
    const gate = createGate();
    this.sendGate = gate.internal;
    return gate.handle;
  }

  blockNextSendAfterDispatch(): GateHandle {
    const gate = createGate();
    this.sendAfterDispatchGate = gate.internal;
    return gate.handle;
  }
}

export function fakePlatformSession(finderUsername = "finder-self"): PlatformSession {
  return {
    transportProfile: "legacy_root",
    cookieJar: serializeJar(new CookieJar()),
    dmCursor: "cursor-1",
    userAgent: "test-agent",
    uin: "10001",
    finderUsername,
    nickname: `账号 ${finderUsername}`,
    token: "test-token",
    acquiredAt: Date.now(),
  };
}

export function fakeDm(
  externalId: string,
  ownIdentity: string,
  text: string,
): NormalizedInboundItem {
  return {
    source: "dm",
    externalId,
    authorId: `peer-${externalId}`,
    authorName: "测试访客",
    text,
    occurredAt: Date.now(),
    target: {
      kind: "dm",
      sessionId: `session-${externalId}`,
      fromUsername: ownIdentity,
      toUsername: `peer-${externalId}`,
    },
    rawShapeVersion: 1,
  };
}

function serializeJar(jar: CookieJar): SerializedCookieJar {
  const serialized = jar.serializeSync();
  if (!serialized) throw new Error("cookie jar serialization failed");
  return serialized;
}

function setSessionCookie(session: PlatformSession, name: string, value: string): void {
  const jar = CookieJar.deserializeSync(session.cookieJar);
  jar.setCookieSync(
    `${name}=${value}; Path=/; Secure; HttpOnly`,
    "https://channels.weixin.qq.com/",
  );
  session.cookieJar = serializeJar(jar);
}

interface AsyncGate {
  wait: Promise<void>;
  markStarted: () => void;
}

interface GateHandle {
  started: Promise<void>;
  release: () => void;
}

function createGate(): { internal: AsyncGate; handle: GateHandle } {
  let markStarted = (): void => undefined;
  let release = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    internal: { wait, markStarted },
    handle: { started, release },
  };
}
