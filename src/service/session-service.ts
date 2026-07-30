import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import {
  createSessionToken,
  digestSessionToken,
} from "../crypto.js";
import type { SecureStore } from "../crypto.js";
import type { DemoRepository, SessionRow } from "../repository.js";
import type {
  NormalizedInboundItem,
  ReplyModelResult,
  SessionSnapshot,
  SharedSessionSummary,
} from "../types.js";
import type { WechatGateway } from "../wechat/client.js";
import type { StoredCredential } from "./credentials.js";

export interface BrowserSession {
  token: string;
  row: SessionRow;
  created: boolean;
}

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: DemoRepository,
    private readonly secureStore: SecureStore,
    private readonly wechat: WechatGateway,
  ) {}

  ensureBrowserSession(rawToken: string | undefined, now = Date.now()): BrowserSession {
    if (rawToken) {
      const id = digestSessionToken(rawToken);
      const existing = this.repository.getSession(id);
      if (existing && existing.expiresAt > now && existing.authState !== "logged_out") {
        return { token: rawToken, row: existing, created: false };
      }
      if (existing) this.repository.deleteSession(id);
    }
    return this.createBrowserSession(now);
  }

  createBrowserSession(now = Date.now()): BrowserSession {
    if (this.repository.countUnexpiredSessions(now) >= this.config.maxActiveSessions) {
      throw new SessionLimitError();
    }
    const token = createSessionToken();
    const id = digestSessionToken(token);
    const row = this.repository.createSession(
      id,
      now,
      now + this.config.sessionTtlMs,
      this.config.autoReplyEnabled && Boolean(this.config.arkApiKey),
    );
    return { token, row, created: true };
  }

  resolve(rawToken: string | undefined, now = Date.now()): SessionRow | null {
    if (!rawToken) return null;
    const row = this.repository.getSession(digestSessionToken(rawToken));
    if (!row || row.expiresAt <= now || row.authState === "logged_out") return null;
    return row;
  }

  resolveShared(sessionId: string | undefined, now = Date.now()): SessionRow | null {
    if (!sessionId) return null;
    const row = this.repository.getSession(sessionId);
    if (!row || row.expiresAt <= now || row.authState === "logged_out") return null;
    return row;
  }

  listSharedSessions(now = Date.now()): SharedSessionSummary[] {
    return this.repository.listUnexpiredSessions(now).flatMap((session) => {
      const credential = this.readCredential(session.id);
      if (credential?.kind !== "session") return [];
      return [{
        sessionId: session.id,
        accountDisplayName: credential.value.nickname,
        authState: session.authState,
        automationEnabled: session.automationEnabled,
        expiresAt: session.expiresAt,
      }];
    });
  }

  async startLogin(session: SessionRow, now = Date.now()): Promise<void> {
    const pending = await this.wechat.createLogin(this.config.qrTtlMs);
    const envelope = this.secureStore.encryptJson(
      { kind: "pending", value: pending } satisfies StoredCredential,
      session.id,
      "credentials",
    );
    this.repository.beginQr(session.id, now, envelope);
  }

  setAutomation(session: SessionRow, enabled: boolean): SessionRow {
    const effective = enabled && this.config.autoReplyEnabled && Boolean(this.config.arkApiKey);
    return this.repository.setAutomation(session.id, effective, Date.now()) ?? session;
  }

  logout(session: SessionRow): void {
    const deleted = this.repository.deleteSession(session.id);
    if (!deleted && this.repository.getSession(session.id)) {
      throw new Error("platform_send_in_flight");
    }
  }

  async snapshot(session: SessionRow): Promise<SessionSnapshot> {
    const current = this.repository.getSession(session.id) ?? session;
    const credential = this.readCredential(current.id);
    let qrDataUrl: string | null = null;
    let qrExpiresAt: number | null = null;
    let accountDisplayName: string | null = null;
    if (credential?.kind === "pending") {
      qrExpiresAt = credential.value.expiresAt;
      if (credential.value.expiresAt > Date.now()) {
        qrDataUrl = await QRCode.toDataURL(
          `https://channels.weixin.qq.com/mobile/confirm_login.html?token=${encodeURIComponent(credential.value.token)}`,
          { errorCorrectionLevel: "M", margin: 2, width: 256 },
        );
      }
    } else if (credential?.kind === "session") {
      accountDisplayName = credential.value.nickname;
    }
    const sources = this.repository.getSources(current.id).map((source) => ({
      source: source.source,
      state: source.state,
      baselineComplete: source.baselineComplete,
      lastSuccessAt: source.lastSuccessAt,
      lastErrorCode: source.lastErrorCode,
    }));
    const timeline = this.repository.listInbound(current.id).map((row) => {
      const item = this.secureStore.decryptJson<NormalizedInboundItem>(
        row.payloadEnvelope,
        current.id,
        `inbound:${row.id}`,
      );
      const reply = this.repository.getReplyForInbound(row.id, current.id);
      let replyText: string | null = null;
      if (reply?.outputEnvelope) {
        replyText = this.secureStore.decryptJson<ReplyModelResult>(
          reply.outputEnvelope,
          current.id,
          `reply:${reply.id}`,
        ).text;
      }
      return {
        id: row.id,
        source: row.source,
        authorName: item.authorName,
        text: item.text,
        occurredAt: row.occurredAt,
        historical: row.historical,
        replyText,
        replyState: reply?.state ?? null,
        replyErrorCode: reply?.errorCode ?? null,
      };
    });
    return {
      authState: current.authState,
      accountDisplayName,
      qrDataUrl,
      qrExpiresAt,
      automationEnabled: current.automationEnabled,
      expiresAt: current.expiresAt,
      sources,
      timeline,
      service: {
        autoReplyEnabled: this.config.autoReplyEnabled,
        modelConfigured: Boolean(this.config.arkApiKey),
      },
    };
  }

  readCredential(sessionId: string): StoredCredential | null {
    const envelope = this.repository.getCredentialEnvelope(sessionId);
    return envelope
      ? this.secureStore.decryptJson<StoredCredential>(envelope, sessionId, "credentials")
      : null;
  }
}

export class SessionLimitError extends Error {
  constructor() {
    super("active_session_limit_reached");
    this.name = "SessionLimitError";
  }
}
