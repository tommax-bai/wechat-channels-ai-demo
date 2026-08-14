import QRCode from "qrcode";
import {
  parseAccountWechatQrDataUrl,
  parseStoredAccountWechatQr,
  storedAccountWechatQr,
} from "../account-wechat-qr.js";
import type { AppConfig } from "../config.js";
import {
  createSessionToken,
  digestSessionToken,
} from "../crypto.js";
import type { SecureStore } from "../crypto.js";
import {
  isSessionRetained,
  type DemoRepository,
  type InboundRow,
  type SessionRow,
} from "../repository.js";
import { DEFAULT_FUNNEL_JOB_NUMBER } from "../reply-defaults.js";
import type {
  AccountQrAsset,
  AccountWechatQrMetadata,
  AccountWechatQrPreview,
  AuthState,
  InboundSource,
  NormalizedInboundItem,
  PartnerContentCursor,
  PartnerContentItem,
  PartnerContentPage,
  ReplyProvider,
  ReplyModelResult,
  SessionSnapshot,
  SharedSessionSummary,
} from "../types.js";
import type { PendingWechatLogin, WechatGateway } from "../wechat/client.js";
import type { StoredCredential } from "./credentials.js";

export interface BrowserSession {
  token: string;
  row: SessionRow;
}

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: DemoRepository,
    private readonly secureStore: SecureStore,
    private readonly wechat: WechatGateway,
  ) {}

  createBrowserSession(now = Date.now()): BrowserSession {
    if (this.repository.countRetainedSessions(now) >= this.config.maxActiveSessions) {
      throw new SessionLimitError();
    }
    const token = createSessionToken();
    const id = digestSessionToken(token);
    const row = this.repository.createSession(
      id,
      now,
      now + this.config.pendingSessionTtlMs,
      this.config.autoReplyEnabled && Boolean(this.config.arkApiKey),
    );
    return { token, row };
  }

  createPartnerSession(now = Date.now()): SessionRow {
    if (!this.config.funnelBaseUrl) throw new Error("funnel_provider_unavailable");
    if (this.repository.countRetainedSessions(now) >= this.config.maxActiveSessions) {
      throw new SessionLimitError();
    }
    const id = digestSessionToken(createSessionToken());
    return this.repository.createSession(
      id,
      now,
      now + this.config.pendingSessionTtlMs,
      true,
      "funnel",
      DEFAULT_FUNNEL_JOB_NUMBER,
    );
  }

  resolve(rawToken: string | undefined, now = Date.now()): SessionRow | null {
    if (!rawToken) return null;
    const row = this.repository.getSession(digestSessionToken(rawToken));
    if (!row || !isSessionRetained(row, now) || row.authState === "logged_out") return null;
    return row;
  }

  resolveShared(sessionId: string | undefined, now = Date.now()): SessionRow | null {
    if (!sessionId) return null;
    const row = this.repository.getSession(sessionId);
    if (!row || !isSessionRetained(row, now) || row.authState === "logged_out") return null;
    return row;
  }

  /**
   * A container retired by a re-login records its successor in linked_session_id. Following that
   * chain (bounded, in case of repeated re-logins) lets a browser holding an affinity to the old
   * container land on the account's live container instead of being asked to scan again.
   */
  resolveSharedFollowingHandoff(
    sessionId: string | undefined,
    now = Date.now(),
  ): SessionRow | null {
    let cursor = sessionId ?? null;
    for (let hop = 0; cursor !== null && hop < 5; hop += 1) {
      const shared = this.resolveShared(cursor, now);
      if (shared) return shared;
      cursor = this.repository.getSession(cursor)?.linkedSessionId ?? null;
    }
    return null;
  }

  listSharedSessions(now = Date.now()): SharedSessionSummary[] {
    return this.repository.listRetainedSessions(now).flatMap((session) => {
      const credential = this.readCredential(session.id);
      if (credential?.kind !== "session") return [];
      return [{
        sessionId: session.id,
        accountDisplayName: credential.value.nickname,
        authState: session.authState,
        automationEnabled: session.automationEnabled,
        replyProvider: session.replyProvider,
        funnelJobNumber: session.funnelJobNumber,
        wechatQr: this.getAccountWechatQrMetadata(session.id),
      }];
    });
  }

  listPartnerSessions(now = Date.now()): SessionRow[] {
    return this.repository.listRetainedSessions(now);
  }

  async startLogin(session: SessionRow, now = Date.now()): Promise<void> {
    const pending = await this.wechat.createLogin(this.config.qrTtlMs);
    const envelope = this.secureStore.encryptJson(
      { kind: "pending", value: pending } satisfies StoredCredential,
      session.id,
      "credentials",
    );
    this.repository.beginQr(
      session.id,
      now,
      now + this.config.pendingSessionTtlMs,
      envelope,
    );
  }

  async startPartnerLogin(session: SessionRow, now = Date.now()): Promise<void> {
    this.assertPartnerLoginAllowed(this.repository.getSession(session.id));
    let pending: PendingWechatLogin;
    try {
      pending = await this.wechat.createLogin(this.config.qrTtlMs);
    } catch (error) {
      throw new Error("partner_login_qr_unavailable", { cause: error });
    }
    this.assertPartnerLoginAllowed(this.repository.getSession(session.id));
    const envelope = this.secureStore.encryptJson(
      { kind: "pending", value: pending } satisfies StoredCredential,
      session.id,
      "credentials",
    );
    this.repository.beginQr(
      session.id,
      now,
      now + this.config.pendingSessionTtlMs,
      envelope,
    );
  }

  setAutomation(session: SessionRow, enabled: boolean): SessionRow {
    const current = this.repository.getSession(session.id) ?? session;
    const effective = enabled
      && this.config.autoReplyEnabled
      && this.isReplyProviderConfigured(current);
    return this.repository.setAutomation(current.id, effective, Date.now()) ?? current;
  }

  reconcileProviderAvailability(now = Date.now()): number {
    let stopped = 0;
    for (const session of this.repository.listRetainedSessions(now)) {
      if (!session.automationEnabled || this.isReplyProviderConfigured(session)) continue;
      const updated = this.repository.stopAutomationForUnavailableProvider(session.id, now);
      if (updated && !updated.automationEnabled) stopped += 1;
    }
    return stopped;
  }

  setReplyProvider(
    session: SessionRow,
    provider: ReplyProvider,
    jobNumber?: string,
  ): SessionRow {
    const current = this.repository.getSession(session.id) ?? session;
    let funnelJobNumber = current.funnelJobNumber;
    if (provider === "funnel") {
      funnelJobNumber = jobNumber?.trim() || null;
      if (!funnelJobNumber) throw new Error("funnel_job_number_required");
      if (!this.config.funnelBaseUrl) throw new Error("funnel_provider_unavailable");
    }
    let updated = this.repository.setReplyProvider(
      current.id,
      provider,
      funnelJobNumber,
      Date.now(),
    ) ?? current;
    if (updated.automationEnabled && !this.isReplyProviderConfigured(updated)) {
      updated = this.repository.setAutomation(updated.id, false, Date.now()) ?? updated;
    }
    return updated;
  }

  getAccountWechatQrMetadata(sessionId: string): AccountWechatQrMetadata {
    const row = this.repository.getAccountQrAsset(sessionId);
    return row
      ? {
          configured: true,
          mimeType: row.mimeType,
          byteLength: row.byteLength,
          updatedAt: row.updatedAt,
        }
      : emptyAccountWechatQrMetadata();
  }

  getAccountWechatQr(session: SessionRow): AccountWechatQrPreview {
    const row = this.repository.getAccountQrAsset(session.id);
    if (!row) return { ...emptyAccountWechatQrMetadata(), dataUrl: null };
    const asset = this.decryptAccountWechatQr(session.id, row.envelope);
    if (asset.mimeType !== row.mimeType || asset.bytes.byteLength !== row.byteLength) {
      throw new Error("account_wechat_qr_invalid");
    }
    return {
      configured: true,
      mimeType: row.mimeType,
      byteLength: row.byteLength,
      updatedAt: row.updatedAt,
      dataUrl: `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`,
    };
  }

  setAccountWechatQr(session: SessionRow, dataUrl: string): AccountWechatQrPreview {
    const parsed = parseAccountWechatQrDataUrl(dataUrl);
    const previous = this.repository.getAccountQrAsset(session.id);
    const now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
    const envelope = this.secureStore.encryptJson(
      storedAccountWechatQr(parsed),
      session.id,
      "account-wechat-qr",
    );
    const row = this.repository.upsertAccountQrAsset({
      sessionId: session.id,
      envelope,
      mimeType: parsed.mimeType,
      byteLength: parsed.bytes.byteLength,
      updatedAt: now,
    });
    return {
      configured: true,
      mimeType: row.mimeType,
      byteLength: row.byteLength,
      updatedAt: row.updatedAt,
      dataUrl: parsed.dataUrl,
    };
  }

  deleteAccountWechatQr(session: SessionRow): AccountWechatQrPreview {
    this.repository.deleteAccountQrAsset(session.id, Date.now());
    return { ...emptyAccountWechatQrMetadata(), dataUrl: null };
  }

  readAccountWechatQrAsset(sessionId: string): AccountQrAsset | null {
    const row = this.repository.getAccountQrAsset(sessionId);
    if (!row) return null;
    const asset = this.decryptAccountWechatQr(sessionId, row.envelope);
    if (asset.mimeType !== row.mimeType || asset.bytes.byteLength !== row.byteLength) {
      throw new Error("account_wechat_qr_invalid");
    }
    return asset;
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
    } else if (credential?.kind === "capturing") {
      accountDisplayName = credential.value.nickname;
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
    // The timeline is the account's, not the container's: rows discovered by a predecessor
    // container survive its retirement, and each envelope decrypts under the partition of the
    // session that wrote it, which the row records.
    const timeline = this.repository.listInbound(current.accountKeyHash).map((row) => {
      const item = this.secureStore.decryptJson<NormalizedInboundItem>(
        row.payloadEnvelope,
        row.sessionId,
        `inbound:${row.id}`,
      );
      const reply = this.repository.getReplyForInbound(row.id);
      let replyText: string | null = null;
      let replyAction: ReplyModelResult["action"] | null = null;
      if (reply?.outputEnvelope) {
        const output = this.secureStore.decryptJson<ReplyModelResult>(
          reply.outputEnvelope,
          reply.sessionId,
          `reply:${reply.id}`,
        );
        replyText = output.text;
        replyAction = output.action ?? null;
      }
      return {
        id: row.id,
        source: row.source,
        authorName: item.authorName,
        text: item.text,
        occurredAt: row.occurredAt,
        historical: row.historical,
        replyText,
        replyAction,
        replyState: reply?.state ?? null,
        replyErrorCode: reply?.errorCode ?? null,
      };
    });
    return {
      sessionId: current.id,
      authState: current.authState,
      authErrorCode: current.lastErrorCode,
      accountDisplayName,
      qrDataUrl,
      qrExpiresAt,
      automationEnabled: current.automationEnabled,
      replyProvider: current.replyProvider,
      funnelJobNumber: current.funnelJobNumber,
      wechatQr: this.getAccountWechatQrMetadata(current.id),
      sources,
      timeline,
      service: {
        autoReplyEnabled: this.config.autoReplyEnabled,
        modelConfigured: Boolean(this.config.arkApiKey),
        chatReplyConfigured: Boolean(this.config.arkApiKey),
        funnelReplyConfigured: Boolean(this.config.funnelBaseUrl),
        selectedProviderConfigured: this.isReplyProviderConfigured(current),
      },
    };
  }

  listPartnerContent(
    session: SessionRow,
    source: InboundSource,
    limit: number,
    cursor?: PartnerContentCursor,
  ): PartnerContentPage {
    const rows = this.repository.listInboundBySource(
      session.accountKeyHash,
      source,
      limit + 1,
      cursor,
    );
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) => this.projectPartnerInbound(session, row)),
      hasMore,
      nextCursorData: hasMore && last
        ? { discoveredAt: last.discoveredAt, id: last.id }
        : null,
    };
  }

  projectPartnerInbound(session: SessionRow, row: InboundRow): PartnerContentItem {
    // Content belongs to the account the caller's session hosts; rows written by a predecessor
    // container are theirs to see, rows of any other account are not.
    if (!session.accountKeyHash || row.accountKeyHash !== session.accountKeyHash) {
      throw new Error("partner_content_session_mismatch");
    }
    const item = this.secureStore.decryptJson<NormalizedInboundItem>(
      row.payloadEnvelope,
      row.sessionId,
      `inbound:${row.id}`,
    );
    const reply = this.repository.getReplyForInbound(row.id);
    const output = reply?.outputEnvelope
      ? this.secureStore.decryptJson<ReplyModelResult>(
          reply.outputEnvelope,
          reply.sessionId,
          `reply:${reply.id}`,
        )
      : null;
    return {
      id: row.id,
      authorName: item.authorName,
      text: item.text,
      occurredAt: row.occurredAt,
      discoveredAt: row.discoveredAt,
      historical: row.historical,
      replyEligible: row.replyEligible,
      reply: reply
        ? {
            state: reply.state,
            text: output?.text ?? null,
            messages: output
              ? output.messages ?? (output.text ? [output.text] : [])
              : [],
            errorCode: reply.errorCode,
            updatedAt: reply.updatedAt,
          }
        : null,
    };
  }

  private assertPartnerLoginAllowed(session: SessionRow | null): asserts session is SessionRow {
    if (!session || session.authState === "logged_out") {
      throw new Error("partner_account_not_found");
    }
    if (
      session.authState === "schema_changed"
      && this.readCredential(session.id)?.kind !== "session"
    ) return;
    const admission: Record<AuthState, "allowed" | "in_progress" | "hosted" | "missing"> = {
      new: "allowed",
      qr_pending: "allowed",
      expired: "allowed",
      cancelled: "allowed",
      no_account: "allowed",
      auth_required: "allowed",
      scanned: "in_progress",
      capturing_context: "in_progress",
      authenticated: "hosted",
      baseline_sync: "hosted",
      active: "hosted",
      stopped: "hosted",
      schema_changed: "hosted",
      logged_out: "missing",
    };
    const result = admission[session.authState];
    if (result === "allowed") return;
    if (result === "in_progress") throw new Error("login_in_progress");
    if (result === "hosted") throw new Error("account_already_hosted");
    throw new Error("partner_account_not_found");
  }

  private isReplyProviderConfigured(session: SessionRow): boolean {
    return session.replyProvider === "chat-llm"
      ? Boolean(this.config.arkApiKey)
      : Boolean(this.config.funnelBaseUrl && session.funnelJobNumber);
  }

  private decryptAccountWechatQr(sessionId: string, envelope: string): AccountQrAsset {
    try {
      const stored = this.secureStore.decryptJson<unknown>(
        envelope,
        sessionId,
        "account-wechat-qr",
      );
      const parsed = parseStoredAccountWechatQr(stored);
      return { mimeType: parsed.mimeType, bytes: parsed.bytes };
    } catch {
      throw new Error("account_wechat_qr_invalid");
    }
  }

  readCredential(sessionId: string): StoredCredential | null {
    const envelope = this.repository.getCredentialEnvelope(sessionId);
    return envelope
      ? this.secureStore.decryptJson<StoredCredential>(envelope, sessionId, "credentials")
      : null;
  }
}

function emptyAccountWechatQrMetadata(): AccountWechatQrMetadata {
  return {
    configured: false,
    mimeType: null,
    byteLength: null,
    updatedAt: null,
  };
}

export class SessionLimitError extends Error {
  constructor() {
    super("active_session_limit_reached");
    this.name = "SessionLimitError";
  }
}
