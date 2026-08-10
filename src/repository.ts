import { randomUUID } from "node:crypto";
import {
  ROLLBACK_SAFE_PLATFORM_EXPIRY_MS,
  type SqliteDatabase,
} from "./database.js";
import type {
  AccountQrAsset,
  AuthState,
  InboundSource,
  ReplyProvider,
  ReplyState,
  SourceState,
} from "./types.js";

export interface SessionRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  platformPersistent: boolean;
  authState: AuthState;
  automationEnabled: boolean;
  replyProvider: ReplyProvider;
  funnelJobNumber: string | null;
  authGeneration: number;
  runGeneration: number;
  accountKeyHash: string | null;
  linkedSessionId: string | null;
  lastErrorCode: string | null;
}

export interface SourceRow {
  sessionId: string;
  source: InboundSource;
  state: SourceState;
  baselineComplete: boolean;
  cursorEnvelope: string | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  nextAttemptAt: number | null;
  updatedAt: number;
}

export interface InboundRow {
  id: string;
  sessionId: string;
  source: InboundSource;
  payloadEnvelope: string;
  occurredAt: number;
  discoveredAt: number;
  historical: boolean;
  replyEligible: boolean;
}

export interface ReplyRow {
  id: string;
  sessionId: string;
  inboundItemId: string;
  state: ReplyState;
  outputEnvelope: string | null;
  model: string | null;
  providerRequestId: string | null;
  platformReceiptHash: string | null;
  platformClientId: string;
  runGeneration: number;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountQrAssetRow {
  sessionId: string;
  envelope: string;
  mimeType: AccountQrAsset["mimeType"];
  byteLength: number;
  updatedAt: number;
}

interface RawSession {
  id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  platform_persistent: number;
  auth_state: AuthState;
  automation_enabled: number;
  reply_provider: ReplyProvider;
  funnel_job_number: string | null;
  auth_generation: number;
  run_generation: number;
  account_key_hash: string | null;
  linked_session_id: string | null;
  last_error_code: string | null;
}

interface RawSource {
  session_id: string;
  source: InboundSource;
  state: SourceState;
  baseline_complete: number;
  cursor_envelope: string | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  consecutive_failures: number;
  next_attempt_at: number | null;
  updated_at: number;
}

interface RawInbound {
  id: string;
  session_id: string;
  source: InboundSource;
  payload_envelope: string;
  occurred_at: number;
  discovered_at: number;
  historical: number;
  reply_eligible: number;
}

interface RawReply {
  id: string;
  session_id: string;
  inbound_item_id: string;
  state: ReplyState;
  output_envelope: string | null;
  model: string | null;
  provider_request_id: string | null;
  platform_receipt_hash: string | null;
  platform_client_id: string;
  run_generation: number;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface RawAccountQrAsset {
  session_id: string;
  envelope: string;
  mime_type: AccountQrAsset["mimeType"];
  byte_length: number;
  updated_at: number;
}

export class DemoRepository {
  constructor(private readonly db: SqliteDatabase) {}

  countRetainedSessions(now: number): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM demo_sessions
        WHERE platform_persistent = 1 OR expires_at > ?
      `)
      .get(now) as { count: number };
    return row.count;
  }

  createSession(
    id: string,
    now: number,
    expiresAt: number,
    automationEnabled: boolean,
    replyProvider: ReplyProvider = "chat-llm",
    funnelJobNumber: string | null = null,
  ): SessionRow {
    this.db
      .prepare(`
        INSERT INTO demo_sessions (
          id, created_at, updated_at, expires_at, auth_state, automation_enabled,
          reply_provider, funnel_job_number
        ) VALUES (?, ?, ?, ?, 'new', ?, ?, ?)
      `)
      .run(
        id,
        now,
        now,
        expiresAt,
        automationEnabled ? 1 : 0,
        replyProvider,
        funnelJobNumber,
      );
    for (const source of ["dm", "comment"] as const) {
      this.db
        .prepare(`
          INSERT INTO source_states (
            session_id, source, state, baseline_complete, updated_at
          ) VALUES (?, ?, 'pending', 0, ?)
        `)
        .run(id, source, now);
    }
    return requireRow(this.getSession(id), "created session");
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM demo_sessions WHERE id = ?").get(id) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  getSessionByAccountKeyHash(accountKeyHash: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM demo_sessions WHERE account_key_hash = ?")
      .get(accountKeyHash) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  listSessionsByAuth(states: readonly AuthState[], now: number): SessionRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(`
        SELECT * FROM demo_sessions
        WHERE auth_state IN (${placeholders})
          AND (platform_persistent = 1 OR expires_at > ?)
        ORDER BY created_at
      `)
      .all(...states, now) as RawSession[];
    return rows.map(mapSession);
  }

  listRetainedSessions(now: number): SessionRow[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM demo_sessions
        WHERE (platform_persistent = 1 OR expires_at > ?)
          AND auth_state <> 'logged_out'
        ORDER BY updated_at DESC
      `)
      .all(now) as RawSession[];
    return rows.map(mapSession);
  }

  beginQr(id: string, now: number, expiresAt: number, credentialEnvelope: string): number {
    return this.db.transaction(() => {
      const session = requireRow(this.getSession(id), "session");
      if (this.hasSendingReply(id)) {
        throw new Error("platform_send_in_flight");
      }
      const generation = session.authGeneration + 1;
      this.db
        .prepare(`
          UPDATE demo_sessions
          SET auth_state = 'qr_pending', auth_generation = ?, run_generation = run_generation + 1,
              account_key_hash = NULL, platform_persistent = 0, expires_at = ?,
              linked_session_id = NULL, last_error_code = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(generation, expiresAt, now, id);
      this.db.prepare("DELETE FROM encrypted_credentials WHERE session_id = ?").run(id);
      this.db
        .prepare(`
          INSERT INTO encrypted_credentials(session_id, envelope, updated_at)
          VALUES (?, ?, ?)
        `)
        .run(id, credentialEnvelope, now);
      this.db.prepare("DELETE FROM inbound_items WHERE session_id = ?").run(id);
      this.db
        .prepare(`
          UPDATE source_states
          SET state = 'pending', baseline_complete = 0, cursor_envelope = NULL,
              last_attempt_at = NULL, last_success_at = NULL,
              last_error_code = NULL, consecutive_failures = 0,
              next_attempt_at = NULL, updated_at = ?
          WHERE session_id = ?
        `)
        .run(now, id);
      this.appendEvent(id, "auth.updated", null, now);
      return generation;
    })();
  }

  setAuthStateIfGeneration(
    id: string,
    generation: number,
    state: AuthState,
    errorCode: string | null,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE demo_sessions
        SET auth_state = ?, last_error_code = ?, updated_at = ?
        WHERE id = ? AND auth_generation = ?
      `)
      .run(state, errorCode, now, id, generation);
    if (result.changes > 0) this.appendEvent(id, "auth.updated", null, now);
    return result.changes > 0;
  }

  completeAuthentication(
    id: string,
    generation: number,
    accountKeyHash: string,
    credentialEnvelope: string,
    now: number,
  ): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(`
          UPDATE demo_sessions
          SET auth_state = 'baseline_sync', account_key_hash = ?, last_error_code = NULL,
              platform_persistent = 1, expires_at = ?,
              run_generation = run_generation + 1, updated_at = ?
          WHERE id = ? AND auth_generation = ?
        `)
        .run(accountKeyHash, ROLLBACK_SAFE_PLATFORM_EXPIRY_MS, now, id, generation);
      if (result.changes === 0) return false;
      this.db
        .prepare(`
          INSERT INTO encrypted_credentials(session_id, envelope, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET envelope = excluded.envelope, updated_at = excluded.updated_at
        `)
        .run(id, credentialEnvelope, now);
      this.appendEvent(id, "auth.updated", null, now);
      return true;
    })();
  }

  linkAuthenticationToExistingAccount(
    id: string,
    generation: number,
    accountKeyHash: string,
    now: number,
  ): SessionRow | null {
    return this.db.transaction(() => {
      const target = this.getSessionByAccountKeyHash(accountKeyHash);
      if (!target || target.id === id) return null;
      const result = this.db
        .prepare(`
          UPDATE demo_sessions
          SET auth_state = 'auth_required', linked_session_id = ?,
              last_error_code = 'account_already_connected', updated_at = ?
          WHERE id = ? AND auth_generation = ?
        `)
        .run(target.id, now, id, generation);
      if (result.changes === 0) return null;
      this.appendEvent(id, "auth.updated", null, now);
      return target;
    })();
  }

  getCredentialEnvelope(id: string): string | null {
    const row = this.db
      .prepare("SELECT envelope FROM encrypted_credentials WHERE session_id = ?")
      .get(id) as { envelope: string } | undefined;
    return row?.envelope ?? null;
  }

  updateCredentialEnvelopeIfGeneration(
    id: string,
    generation: number,
    envelope: string,
    now: number,
  ): boolean {
    const current = this.db
      .prepare("SELECT auth_generation FROM demo_sessions WHERE id = ?")
      .get(id) as { auth_generation: number } | undefined;
    if (!current || current.auth_generation !== generation) return false;
    this.db
      .prepare(`
        INSERT INTO encrypted_credentials(session_id, envelope, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET envelope = excluded.envelope, updated_at = excluded.updated_at
      `)
      .run(id, envelope, now);
    return true;
  }

  setAutomation(id: string, enabled: boolean, now: number): SessionRow | null {
    const targetState: AuthState | null = enabled ? null : "stopped";
    const result = this.db
      .prepare(`
        UPDATE demo_sessions
        SET automation_enabled = ?, run_generation = run_generation + 1,
            auth_state = CASE
              WHEN ? IS NULL AND auth_state = 'stopped' THEN 'active'
              WHEN ? IS NOT NULL AND auth_state IN ('active', 'baseline_sync') THEN ?
              ELSE auth_state
            END,
            updated_at = ?
        WHERE id = ?
      `)
      .run(enabled ? 1 : 0, targetState, targetState, targetState, now, id);
    if (result.changes > 0) this.appendEvent(id, "connection.updated", null, now);
    return this.getSession(id);
  }

  stopAutomationForUnavailableProvider(id: string, now: number): SessionRow | null {
    return this.db.transaction(() => {
      const current = this.db
        .prepare("SELECT automation_enabled FROM demo_sessions WHERE id = ?")
        .get(id) as { automation_enabled: number } | undefined;
      if (!current || current.automation_enabled !== 1) return this.getSession(id);

      const queued = this.db
        .prepare("SELECT id FROM reply_jobs WHERE session_id = ? AND state = 'queued'")
        .all(id) as Array<{ id: string }>;
      this.db
        .prepare(`
          UPDATE reply_jobs
          SET state = 'failed', error_code = 'provider_unavailable_on_restart', updated_at = ?
          WHERE session_id = ? AND state = 'queued'
        `)
        .run(now, id);
      this.db
        .prepare(`
          UPDATE demo_sessions
          SET automation_enabled = 0, run_generation = run_generation + 1,
              auth_state = CASE
                WHEN auth_state IN ('active', 'baseline_sync') THEN 'stopped'
                ELSE auth_state
              END,
              updated_at = ?
          WHERE id = ? AND automation_enabled = 1
        `)
        .run(now, id);
      for (const reply of queued) {
        this.appendEvent(id, "reply.updated", reply.id, now);
      }
      this.appendEvent(id, "connection.updated", null, now);
      return this.getSession(id);
    })();
  }

  setReplyProvider(
    id: string,
    provider: ReplyProvider,
    funnelJobNumber: string | null,
    now: number,
  ): SessionRow | null {
    const result = this.db
      .prepare(`
        UPDATE demo_sessions
        SET reply_provider = ?, funnel_job_number = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(provider, funnelJobNumber, now, id);
    if (result.changes > 0) this.appendEvent(id, "settings.updated", null, now);
    return this.getSession(id);
  }

  getAccountQrAsset(sessionId: string): AccountQrAssetRow | null {
    const row = this.db
      .prepare("SELECT * FROM account_qr_assets WHERE session_id = ?")
      .get(sessionId) as RawAccountQrAsset | undefined;
    return row ? mapAccountQrAsset(row) : null;
  }

  upsertAccountQrAsset(input: AccountQrAssetRow): AccountQrAssetRow {
    return this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO account_qr_assets (
            session_id, envelope, mime_type, byte_length, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            envelope = excluded.envelope,
            mime_type = excluded.mime_type,
            byte_length = excluded.byte_length,
            updated_at = excluded.updated_at
        `)
        .run(
          input.sessionId,
          input.envelope,
          input.mimeType,
          input.byteLength,
          input.updatedAt,
        );
      this.db
        .prepare("UPDATE demo_sessions SET updated_at = ? WHERE id = ?")
        .run(input.updatedAt, input.sessionId);
      this.appendEvent(input.sessionId, "settings.updated", "wechat-qr", input.updatedAt);
      return requireRow(this.getAccountQrAsset(input.sessionId), "account QR asset");
    })();
  }

  deleteAccountQrAsset(sessionId: string, now: number): boolean {
    return this.db.transaction(() => {
      const deleted = this.db
        .prepare("DELETE FROM account_qr_assets WHERE session_id = ?")
        .run(sessionId).changes > 0;
      if (!deleted) return false;
      this.db
        .prepare("UPDATE demo_sessions SET updated_at = ? WHERE id = ?")
        .run(now, sessionId);
      this.appendEvent(sessionId, "settings.updated", "wechat-qr", now);
      return true;
    })();
  }

  setSessionActiveIfBaselinesComplete(id: string, authGeneration: number, now: number): boolean {
    const summary = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN baseline_complete = 1 THEN 1 ELSE 0 END) AS available
        FROM source_states WHERE session_id = ?
      `)
      .get(id) as { pending: number; available: number };
    if (summary.pending > 0 || summary.available < 1) return false;
    const result = this.db
      .prepare(`
        UPDATE demo_sessions
        SET auth_state = CASE WHEN automation_enabled = 1 THEN 'active' ELSE 'stopped' END,
            updated_at = ?
        WHERE id = ? AND auth_state = 'baseline_sync' AND auth_generation = ?
      `)
      .run(now, id, authGeneration);
    if (result.changes > 0) this.appendEvent(id, "connection.updated", null, now);
    return result.changes > 0;
  }

  getSources(id: string): SourceRow[] {
    const rows = this.db
      .prepare("SELECT * FROM source_states WHERE session_id = ? ORDER BY source")
      .all(id) as RawSource[];
    return rows.map(mapSource);
  }

  getSource(id: string, source: InboundSource): SourceRow | null {
    const row = this.db
      .prepare("SELECT * FROM source_states WHERE session_id = ? AND source = ?")
      .get(id, source) as RawSource | undefined;
    return row ? mapSource(row) : null;
  }

  recoverCommentCursorTargetMissing(
    id: string,
    authGeneration: number,
    now: number,
  ): SourceRow | null {
    const result = this.db
      .prepare(`
        UPDATE source_states
        SET state = 'pending', baseline_complete = 0,
            last_error_code = NULL, consecutive_failures = 0,
            next_attempt_at = NULL, updated_at = ?
        WHERE session_id = ? AND source = 'comment'
          AND state = 'schema_changed'
          AND last_error_code = 'schema_changed:post.cursor_target_missing'
          AND cursor_envelope IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM demo_sessions
            WHERE id = ? AND auth_generation = ?
          )
      `)
      .run(now, id, id, authGeneration);
    if (result.changes === 0) return null;
    this.appendEvent(id, "connection.updated", "comment", now);
    return this.getSource(id, "comment");
  }

  markCommentSyncAttempt(
    id: string,
    authGeneration: number,
    cursorEnvelope: string,
    now: number,
  ): SourceRow | null {
    const result = this.db
      .prepare(`
        UPDATE source_states
        SET cursor_envelope = ?, last_attempt_at = ?, updated_at = ?
        WHERE session_id = ? AND source = 'comment'
          AND EXISTS (
            SELECT 1 FROM demo_sessions
            WHERE id = ? AND auth_generation = ?
          )
      `)
      .run(cursorEnvelope, now, now, id, id, authGeneration);
    if (result.changes === 0) return null;
    this.appendEvent(id, "connection.updated", "comment", now);
    return this.getSource(id, "comment");
  }

  updateSource(
    id: string,
    authGeneration: number,
    source: InboundSource,
    update: {
      state: SourceState;
      baselineComplete: boolean;
      cursorEnvelope: string | null;
      lastSuccessAt: number | null;
      lastErrorCode: string | null;
      /**
       * Both pacing fields are required rather than optional. An omitted field would silently
       * inherit whatever pacing the row already held, which is how a lane ends up quietly stuck
       * on a stale backoff; every writer must say what the schedule is now.
       */
      consecutiveFailures: number;
      nextAttemptAt: number | null;
    },
    now: number,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE source_states
        SET state = ?, baseline_complete = ?, cursor_envelope = ?,
            last_success_at = ?, last_error_code = ?,
            consecutive_failures = ?, next_attempt_at = ?, updated_at = ?
        WHERE session_id = ? AND source = ?
          AND EXISTS (
            SELECT 1 FROM demo_sessions
            WHERE id = ? AND auth_generation = ?
          )
      `)
      .run(
        update.state,
        update.baselineComplete ? 1 : 0,
        update.cursorEnvelope,
        update.lastSuccessAt,
        update.lastErrorCode,
        update.consecutiveFailures,
        update.nextAttemptAt,
        now,
        id,
        source,
        id,
        authGeneration,
      );
    if (result.changes > 0) this.appendEvent(id, "connection.updated", source, now);
    return result.changes > 0;
  }

  /**
   * Newest platform timestamp already stored for a source. It is the reply watermark once a lane
   * reads a window instead of a strict delta: anything at or before what we already hold is content
   * we have seen, not something that just arrived.
   */
  latestInboundOccurredAt(id: string, source: InboundSource): number | null {
    const row = this.db
      .prepare(
        "SELECT MAX(occurred_at) AS value FROM inbound_items WHERE session_id = ? AND source = ?",
      )
      .get(id, source) as { value: number | null } | undefined;
    return row?.value ?? null;
  }

  insertInbound(input: {
    id: string;
    sessionId: string;
    source: InboundSource;
    externalIdHash: string;
    payloadEnvelope: string;
    occurredAt: number;
    discoveredAt: number;
    historical: boolean;
    replyEligible: boolean;
    authGeneration: number;
    runGeneration: number;
    platformClientId: string;
  }): { inserted: boolean; replyId: string | null } {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(`
          INSERT OR IGNORE INTO inbound_items (
            id, session_id, source, external_id_hash, payload_envelope, occurred_at,
            discovered_at, historical, reply_eligible
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM demo_sessions
            WHERE id = ? AND auth_generation = ?
          )
        `)
        .run(
          input.id,
          input.sessionId,
          input.source,
          input.externalIdHash,
          input.payloadEnvelope,
          input.occurredAt,
          input.discoveredAt,
          input.historical ? 1 : 0,
          input.replyEligible ? 1 : 0,
          input.sessionId,
          input.authGeneration,
        );
      if (result.changes === 0) return { inserted: false, replyId: null };
      let replyId: string | null = null;
      if (input.replyEligible) {
        replyId = randomUUID();
        this.db
          .prepare(`
            INSERT INTO reply_jobs (
              id, session_id, inbound_item_id, state, platform_client_id,
              run_generation, created_at, updated_at
            ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
          `)
          .run(
            replyId,
            input.sessionId,
            input.id,
            input.platformClientId,
            input.runGeneration,
            input.discoveredAt,
            input.discoveredAt,
          );
      }
      this.appendEvent(input.sessionId, "inbound.received", input.id, input.discoveredAt);
      return { inserted: true, replyId };
    })();
  }

  listInbound(id: string, limit = 100): InboundRow[] {
    const rows = this.db
      .prepare(`
        SELECT id, session_id, source, payload_envelope, occurred_at, discovered_at,
               historical, reply_eligible
        FROM inbound_items
        WHERE session_id = ?
        ORDER BY discovered_at DESC
        LIMIT ?
      `)
      .all(id, limit) as RawInbound[];
    return rows.map(mapInbound);
  }

  listInboundBySource(
    sessionId: string,
    source: InboundSource,
    limitPlusOne: number,
    cursor?: { discoveredAt: number; id: string },
  ): InboundRow[] {
    const rows = cursor
      ? this.db
          .prepare(`
            SELECT id, session_id, source, payload_envelope, occurred_at, discovered_at,
                   historical, reply_eligible
            FROM inbound_items
            WHERE session_id = ? AND source = ?
              AND ((discovered_at < ?) OR (discovered_at = ? AND id < ?))
            ORDER BY discovered_at DESC, id DESC
            LIMIT ?
          `)
          .all(
            sessionId,
            source,
            cursor.discoveredAt,
            cursor.discoveredAt,
            cursor.id,
            limitPlusOne,
          ) as RawInbound[]
      : this.db
          .prepare(`
            SELECT id, session_id, source, payload_envelope, occurred_at, discovered_at,
                   historical, reply_eligible
            FROM inbound_items
            WHERE session_id = ? AND source = ?
            ORDER BY discovered_at DESC, id DESC
            LIMIT ?
          `)
          .all(sessionId, source, limitPlusOne) as RawInbound[];
    return rows.map(mapInbound);
  }

  getInbound(id: string, sessionId: string): InboundRow | null {
    const row = this.db
      .prepare(`
        SELECT id, session_id, source, payload_envelope, occurred_at, discovered_at,
               historical, reply_eligible
        FROM inbound_items WHERE id = ? AND session_id = ?
      `)
      .get(id, sessionId) as RawInbound | undefined;
    return row ? mapInbound(row) : null;
  }

  getReplyForInbound(inboundId: string, sessionId: string): ReplyRow | null {
    const row = this.db
      .prepare("SELECT * FROM reply_jobs WHERE inbound_item_id = ? AND session_id = ?")
      .get(inboundId, sessionId) as RawReply | undefined;
    return row ? mapReply(row) : null;
  }

  claimReply(now: number): ReplyRow | null {
    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(`
          SELECT r.*
          FROM reply_jobs r
          JOIN demo_sessions s ON s.id = r.session_id
          WHERE r.state = 'queued'
            AND s.auth_state = 'active'
            AND s.automation_enabled = 1
            AND (s.platform_persistent = 1 OR s.expires_at > ?)
            AND r.run_generation = s.run_generation
            AND NOT EXISTS (
              SELECT 1 FROM reply_jobs busy
              WHERE busy.session_id = r.session_id
                AND busy.state IN ('generating', 'generated', 'sending')
            )
          ORDER BY r.created_at
          LIMIT 1
        `)
        .get(now) as RawReply | undefined;
      if (!candidate) return null;
      const updated = this.db
        .prepare(`
          UPDATE reply_jobs SET state = 'generating', updated_at = ?
          WHERE id = ? AND state = 'queued'
        `)
        .run(now, candidate.id);
      if (updated.changes === 0) return null;
      this.appendEvent(candidate.session_id, "reply.updated", candidate.id, now);
      return mapReply({ ...candidate, state: "generating", updated_at: now });
    })();
  }

  updateReply(
    id: string,
    sessionId: string,
    state: ReplyState,
    update: {
      outputEnvelope?: string | null;
      model?: string | null;
      providerRequestId?: string | null;
      platformReceiptHash?: string | null;
      errorCode?: string | null;
    },
    now: number,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE reply_jobs
        SET state = ?,
            output_envelope = COALESCE(?, output_envelope),
            model = COALESCE(?, model),
            provider_request_id = COALESCE(?, provider_request_id),
            platform_receipt_hash = COALESCE(?, platform_receipt_hash),
            error_code = ?,
            updated_at = ?
        WHERE id = ? AND session_id = ?
      `)
      .run(
        state,
        update.outputEnvelope ?? null,
        update.model ?? null,
        update.providerRequestId ?? null,
        update.platformReceiptHash ?? null,
        update.errorCode ?? null,
        now,
        id,
        sessionId,
      );
    if (result.changes > 0) this.appendEvent(sessionId, "reply.updated", id, now);
    return result.changes > 0;
  }

  beginSendReply(
    replyId: string,
    sessionId: string,
    authGeneration: number,
    runGeneration: number,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE reply_jobs
        SET state = 'sending', error_code = NULL, updated_at = ?
        WHERE id = ? AND session_id = ? AND state = 'generated'
          AND run_generation = ?
          AND EXISTS (
            SELECT 1 FROM demo_sessions
            WHERE id = ? AND auth_state = 'active' AND automation_enabled = 1
              AND auth_generation = ? AND run_generation = ?
              AND (platform_persistent = 1 OR expires_at > ?)
          )
      `)
      .run(
        now,
        replyId,
        sessionId,
        runGeneration,
        sessionId,
        authGeneration,
        runGeneration,
        now,
      );
    if (result.changes > 0) this.appendEvent(sessionId, "reply.updated", replyId, now);
    return result.changes > 0;
  }

  isSendAuthorized(
    replyId: string,
    sessionId: string,
    authGeneration: number,
    runGeneration: number,
    now: number,
  ): boolean {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM reply_jobs r
        JOIN demo_sessions s ON s.id = r.session_id
        WHERE r.id = ? AND r.session_id = ? AND r.state = 'sending'
          AND r.run_generation = ? AND s.run_generation = ?
          AND s.auth_generation = ? AND s.auth_state = 'active'
          AND s.automation_enabled = 1
          AND (s.platform_persistent = 1 OR s.expires_at > ?)
      `)
      .get(
        replyId,
        sessionId,
        runGeneration,
        runGeneration,
        authGeneration,
        now,
      ) as { count: number };
    return row.count === 1;
  }

  recoverInterruptedReplies(now: number): {
    submittedUnknown: number;
    requeued: number;
    failed: number;
  } {
    return this.db.transaction(() => {
      const sending = this.db
        .prepare("SELECT id, session_id FROM reply_jobs WHERE state = 'sending'")
        .all() as Array<{ id: string; session_id: string }>;
      const reversible = this.db
        .prepare(`
          SELECT r.id, r.session_id, r.run_generation,
                 s.auth_state, s.automation_enabled, s.run_generation AS current_generation,
                 s.expires_at, s.platform_persistent
          FROM reply_jobs r
          JOIN demo_sessions s ON s.id = r.session_id
          WHERE r.state IN ('generating', 'generated')
        `)
        .all() as Array<{
          id: string;
          session_id: string;
          run_generation: number;
          auth_state: AuthState;
          automation_enabled: number;
          current_generation: number;
          expires_at: number;
          platform_persistent: number;
        }>;
      const markUnknown = this.db.prepare(`
        UPDATE reply_jobs
        SET state = 'submitted_unknown', error_code = 'process_restarted_after_dispatch', updated_at = ?
        WHERE id = ? AND state = 'sending'
      `);
      const markReversible = this.db.prepare(`
        UPDATE reply_jobs
        SET state = ?, error_code = ?, updated_at = ?
        WHERE id = ? AND state IN ('generating', 'generated')
      `);
      for (const row of sending) {
        markUnknown.run(now, row.id);
        this.appendEvent(row.session_id, "reply.updated", row.id, now);
      }
      let requeued = 0;
      let failed = 0;
      for (const row of reversible) {
        const authorized =
          row.auth_state === "active"
          && row.automation_enabled === 1
          && row.run_generation === row.current_generation
          && (row.platform_persistent === 1 || row.expires_at > now);
        markReversible.run(
          authorized ? "queued" : "failed",
          authorized ? "process_restarted_before_dispatch" : "authorization_changed_during_restart",
          now,
          row.id,
        );
        if (authorized) requeued += 1;
        else failed += 1;
        this.appendEvent(row.session_id, "reply.updated", row.id, now);
      }
      return { submittedUnknown: sending.length, requeued, failed };
    })();
  }

  listEvents(sessionId: string, afterSeq: number, limit = 250): Array<{
    seq: number;
    type: string;
    entityId: string | null;
    createdAt: number;
  }> {
    return this.db
      .prepare(`
        SELECT seq, type, entity_id AS entityId, created_at AS createdAt
        FROM ui_events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?
      `)
      .all(sessionId, afterSeq, limit) as Array<{
        seq: number;
        type: string;
        entityId: string | null;
        createdAt: number;
      }>;
  }

  deleteSession(id: string): boolean {
    return this.db.transaction(() => {
      if (this.hasSendingReply(id)) return false;
      return this.db.prepare("DELETE FROM demo_sessions WHERE id = ?").run(id).changes > 0;
    })();
  }

  deleteExpired(now: number): number {
    return this.db
      .prepare(`
        DELETE FROM demo_sessions
        WHERE platform_persistent = 0
          AND expires_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM reply_jobs
            WHERE reply_jobs.session_id = demo_sessions.id
              AND reply_jobs.state = 'sending'
          )
      `)
      .run(now).changes;
  }

  hasSendingReply(id: string): boolean {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM reply_jobs
        WHERE session_id = ? AND state = 'sending'
      `)
      .get(id) as { count: number };
    return row.count > 0;
  }

  private appendEvent(sessionId: string, type: string, entityId: string | null, now: number): number {
    const result = this.db
      .prepare("INSERT INTO ui_events(session_id, type, entity_id, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, type, entityId, now);
    return Number(result.lastInsertRowid);
  }
}

function mapSession(row: RawSession): SessionRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    platformPersistent: row.platform_persistent === 1,
    authState: row.auth_state,
    automationEnabled: row.automation_enabled === 1,
    replyProvider: row.reply_provider,
    funnelJobNumber: row.funnel_job_number,
    authGeneration: row.auth_generation,
    runGeneration: row.run_generation,
    accountKeyHash: row.account_key_hash,
    linkedSessionId: row.linked_session_id,
    lastErrorCode: row.last_error_code,
  };
}

function mapAccountQrAsset(row: RawAccountQrAsset): AccountQrAssetRow {
  return {
    sessionId: row.session_id,
    envelope: row.envelope,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    updatedAt: row.updated_at,
  };
}

export function isSessionRetained(session: SessionRow, now: number): boolean {
  return session.platformPersistent || session.expiresAt > now;
}

function mapSource(row: RawSource): SourceRow {
  return {
    sessionId: row.session_id,
    source: row.source,
    state: row.state,
    baselineComplete: row.baseline_complete === 1,
    cursorEnvelope: row.cursor_envelope,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    consecutiveFailures: row.consecutive_failures ?? 0,
    nextAttemptAt: row.next_attempt_at ?? null,
    updatedAt: row.updated_at,
  };
}

function mapInbound(row: RawInbound): InboundRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    payloadEnvelope: row.payload_envelope,
    occurredAt: row.occurred_at,
    discoveredAt: row.discovered_at,
    historical: row.historical === 1,
    replyEligible: row.reply_eligible === 1,
  };
}

function mapReply(row: RawReply): ReplyRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    inboundItemId: row.inbound_item_id,
    state: row.state,
    outputEnvelope: row.output_envelope,
    model: row.model,
    providerRequestId: row.provider_request_id,
    platformReceiptHash: row.platform_receipt_hash,
    platformClientId: row.platform_client_id,
    runGeneration: row.run_generation,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireRow<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`${label} was not found`);
  return value;
}
