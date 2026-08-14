import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export const ROLLBACK_SAFE_PLATFORM_EXPIRY_MS = 8_640_000_000_000_000;

export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS demo_sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      platform_persistent INTEGER NOT NULL DEFAULT 0 CHECK (platform_persistent IN (0, 1)),
      auth_state TEXT NOT NULL,
      automation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automation_enabled IN (0, 1)),
      reply_provider TEXT NOT NULL DEFAULT 'chat-llm'
        CHECK (reply_provider IN ('chat-llm', 'funnel')),
      funnel_job_number TEXT,
      wechat_contact_id TEXT,
      contact_reply_type TEXT NOT NULL DEFAULT 'qr'
        CHECK (contact_reply_type IN ('qr', 'wechat_id')),
      auth_generation INTEGER NOT NULL DEFAULT 0,
      run_generation INTEGER NOT NULL DEFAULT 0,
      account_key_hash TEXT UNIQUE,
      linked_session_id TEXT,
      last_error_code TEXT,
      last_login_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_demo_sessions_expiry
      ON demo_sessions(expires_at);

    CREATE INDEX IF NOT EXISTS idx_demo_sessions_auth_state
      ON demo_sessions(auth_state);

    CREATE TABLE IF NOT EXISTS encrypted_credentials (
      session_id TEXT PRIMARY KEY REFERENCES demo_sessions(id) ON DELETE CASCADE,
      envelope TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_qr_assets (
      session_id TEXT PRIMARY KEY REFERENCES demo_sessions(id) ON DELETE CASCADE,
      envelope TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
      byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND ${512 * 1_024}),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_states (
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('dm', 'comment')),
      state TEXT NOT NULL,
      baseline_complete INTEGER NOT NULL DEFAULT 0 CHECK (baseline_complete IN (0, 1)),
      cursor_envelope TEXT,
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      last_error_code TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      sweep_rank INTEGER,
      sweep_attempt_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, source)
    );

    CREATE TABLE IF NOT EXISTS inbound_items (
      id TEXT PRIMARY KEY,
      account_key_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('dm', 'comment')),
      external_id_hash TEXT NOT NULL,
      payload_envelope TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      discovered_at INTEGER NOT NULL,
      historical INTEGER NOT NULL CHECK (historical IN (0, 1)),
      reply_eligible INTEGER NOT NULL CHECK (reply_eligible IN (0, 1)),
      UNIQUE (account_key_hash, source, external_id_hash)
    );

    CREATE TABLE IF NOT EXISTS reply_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      inbound_item_id TEXT NOT NULL UNIQUE REFERENCES inbound_items(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      output_envelope TEXT,
      model TEXT,
      provider_request_id TEXT,
      platform_receipt_hash TEXT,
      platform_client_id TEXT NOT NULL UNIQUE,
      run_generation INTEGER NOT NULL,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reply_jobs_claim
      ON reply_jobs(state, created_at);

    CREATE TABLE IF NOT EXISTS ui_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      entity_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ui_events_session_seq
      ON ui_events(session_id, seq);
  `);
  const replyColumns = db.pragma("table_info(reply_jobs)") as Array<{ name: string }>;
  if (!replyColumns.some((column) => column.name === "platform_receipt_hash")) {
    db.exec("ALTER TABLE reply_jobs ADD COLUMN platform_receipt_hash TEXT");
  }
  const sessionColumns = db.pragma("table_info(demo_sessions)") as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "platform_persistent")) {
    db.exec(`
      ALTER TABLE demo_sessions
      ADD COLUMN platform_persistent INTEGER NOT NULL DEFAULT 0
        CHECK (platform_persistent IN (0, 1))
    `);
  }
  if (!sessionColumns.some((column) => column.name === "reply_provider")) {
    db.exec(`
      ALTER TABLE demo_sessions
      ADD COLUMN reply_provider TEXT NOT NULL DEFAULT 'chat-llm'
        CHECK (reply_provider IN ('chat-llm', 'funnel'))
    `);
  }
  if (!sessionColumns.some((column) => column.name === "funnel_job_number")) {
    db.exec("ALTER TABLE demo_sessions ADD COLUMN funnel_job_number TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "wechat_contact_id")) {
    db.exec("ALTER TABLE demo_sessions ADD COLUMN wechat_contact_id TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "contact_reply_type")) {
    db.exec(`
      ALTER TABLE demo_sessions
      ADD COLUMN contact_reply_type TEXT NOT NULL DEFAULT 'qr'
        CHECK (contact_reply_type IN ('qr', 'wechat_id'))
    `);
  }
  if (!sessionColumns.some((column) => column.name === "linked_session_id")) {
    db.exec("ALTER TABLE demo_sessions ADD COLUMN linked_session_id TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "last_login_at")) {
    db.exec("ALTER TABLE demo_sessions ADD COLUMN last_login_at INTEGER");
    // A retained row's true login time is unknowable, so the migration moment stands in for it:
    // everything already in flight is historical at cutover, and nothing pre-deploy is answered.
    db.prepare(`
      UPDATE demo_sessions
      SET last_login_at = ?
      WHERE account_key_hash IS NOT NULL
    `).run(Date.now());
  }
  const sourceColumns = db.pragma("table_info(source_states)") as Array<{ name: string }>;
  if (!sourceColumns.some((column) => column.name === "last_attempt_at")) {
    db.exec("ALTER TABLE source_states ADD COLUMN last_attempt_at INTEGER");
  }
  // Retry pacing must survive a restart: an in-memory backoff would let a process bounce turn a
  // slow schema retry back into a full-cadence poll, and the incident that motivated these columns
  // was only visible because source state is the durable record of what a lane is doing.
  if (!sourceColumns.some((column) => column.name === "consecutive_failures")) {
    db.exec("ALTER TABLE source_states ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
  }
  if (!sourceColumns.some((column) => column.name === "next_attempt_at")) {
    db.exec("ALTER TABLE source_states ADD COLUMN next_attempt_at INTEGER");
  }
  // Null sweep state means the first sweep step may start immediately at the first swept rank.
  if (!sourceColumns.some((column) => column.name === "sweep_rank")) {
    db.exec("ALTER TABLE source_states ADD COLUMN sweep_rank INTEGER");
  }
  if (!sourceColumns.some((column) => column.name === "sweep_attempt_at")) {
    db.exec("ALTER TABLE source_states ADD COLUMN sweep_attempt_at INTEGER");
  }
  migrateInboundToAccountDimension(db);
  // Created after the rebuild migration: on a legacy database the columns only exist once the
  // inbound table has been re-keyed to the account dimension.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbound_account_time
      ON inbound_items(account_key_hash, discovered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbound_account_source_time_id
      ON inbound_items(account_key_hash, source, discovered_at DESC, id DESC);
  `);
  db.exec(`
    UPDATE source_states
    SET last_attempt_at = updated_at
    WHERE source = 'comment'
      AND last_attempt_at IS NULL
      AND (
        state <> 'pending'
        OR cursor_envelope IS NOT NULL
        OR last_success_at IS NOT NULL
        OR last_error_code IS NOT NULL
      )
  `);
  db.prepare(`
    UPDATE demo_sessions
    SET platform_persistent = 1,
        expires_at = MAX(expires_at, ?)
    WHERE account_key_hash IS NOT NULL
      AND auth_state IN (
        'authenticated', 'baseline_sync', 'active', 'stopped',
        'auth_required', 'schema_changed'
      )
  `).run(ROLLBACK_SAFE_PLATFORM_EXPIRY_MS);
  if ((db.pragma("user_version", { simple: true }) as number) === 0) {
    db.pragma(`user_version = ${INBOUND_ACCOUNT_HASHES_READY}`);
  }
  return db;
}

/** user_version marks how far the inbound account-dimension migration has run. */
const INBOUND_ACCOUNT_ROWS_REBUILT = 1;
const INBOUND_ACCOUNT_HASHES_READY = 2;

/**
 * Messages belong to the WeChat account, not to the container that happened to discover them, so
 * the rebuilt table keys rows by account_key_hash and drops the session cascade: history must
 * survive the container being retired and cleaned up. Rows whose session no longer holds an
 * account are copies the account's current holder also carries (or leftovers of a disconnected
 * account) and are dropped rather than left unattributable. Dedup hashes still live in the old
 * per-session namespace after this rebuild — completeInboundAccountMigration must run before any
 * sync worker polls, or the first overlap read would double-insert everything.
 */
function migrateInboundToAccountDimension(db: SqliteDatabase): void {
  const inboundColumns = db.pragma("table_info(inbound_items)") as Array<{ name: string }>;
  if (inboundColumns.some((column) => column.name === "account_key_hash")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE inbound_items_account (
        id TEXT PRIMARY KEY,
        account_key_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('dm', 'comment')),
        external_id_hash TEXT NOT NULL,
        payload_envelope TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        discovered_at INTEGER NOT NULL,
        historical INTEGER NOT NULL CHECK (historical IN (0, 1)),
        reply_eligible INTEGER NOT NULL CHECK (reply_eligible IN (0, 1)),
        UNIQUE (account_key_hash, source, external_id_hash)
      );
      INSERT INTO inbound_items_account (
        id, account_key_hash, session_id, source, external_id_hash, payload_envelope,
        occurred_at, discovered_at, historical, reply_eligible
      )
      SELECT i.id, s.account_key_hash, i.session_id, i.source, i.external_id_hash,
             i.payload_envelope, i.occurred_at, i.discovered_at, i.historical, i.reply_eligible
      FROM inbound_items i
      JOIN demo_sessions s ON s.id = i.session_id
      WHERE s.account_key_hash IS NOT NULL;
      DROP TABLE inbound_items;
      ALTER TABLE inbound_items_account RENAME TO inbound_items;
      CREATE TABLE reply_jobs_account (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        inbound_item_id TEXT NOT NULL UNIQUE REFERENCES inbound_items(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        output_envelope TEXT,
        model TEXT,
        provider_request_id TEXT,
        platform_receipt_hash TEXT,
        platform_client_id TEXT NOT NULL UNIQUE,
        run_generation INTEGER NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO reply_jobs_account (
        id, session_id, inbound_item_id, state, output_envelope, model, provider_request_id,
        platform_receipt_hash, platform_client_id, run_generation, error_code, created_at,
        updated_at
      )
      SELECT r.id, r.session_id, r.inbound_item_id, r.state, r.output_envelope, r.model,
             r.provider_request_id, r.platform_receipt_hash, r.platform_client_id,
             r.run_generation, r.error_code, r.created_at, r.updated_at
      FROM reply_jobs r
      WHERE EXISTS (SELECT 1 FROM inbound_items i WHERE i.id = r.inbound_item_id);
      DROP TABLE reply_jobs;
      ALTER TABLE reply_jobs_account RENAME TO reply_jobs;
      CREATE INDEX idx_reply_jobs_claim ON reply_jobs(state, created_at);
    `);
    db.pragma(`user_version = ${INBOUND_ACCOUNT_ROWS_REBUILT}`);
  })();
  db.pragma("foreign_keys = ON");
}

/**
 * Second half of the account-dimension migration, split out because it needs the encryption key:
 * legacy dedup hashes were keyed by the discovering session, so the same platform message would
 * not match them once inserts hash in the account namespace. Every carried-over row is re-keyed
 * from its decrypted payload's externalId; a row that cannot be decrypted or re-keyed without
 * colliding is dropped, because an unmatchable dedup entry is worse than a missing display row.
 * Must run at startup before the sync workers poll.
 */
export function completeInboundAccountMigration(
  db: SqliteDatabase,
  secureStore: {
    decryptJson<T>(raw: string, sessionId: string, purpose: string): T;
    keyedHash(value: string, namespace: string): string;
  },
): { rehashed: number; dropped: number } {
  if ((db.pragma("user_version", { simple: true }) as number) >= INBOUND_ACCOUNT_HASHES_READY) {
    return { rehashed: 0, dropped: 0 };
  }
  let rehashed = 0;
  let dropped = 0;
  db.transaction(() => {
    const rows = db
      .prepare(`
        SELECT id, account_key_hash, session_id, source, external_id_hash, payload_envelope
        FROM inbound_items
      `)
      .all() as Array<{
        id: string;
        account_key_hash: string;
        session_id: string;
        source: string;
        external_id_hash: string;
        payload_envelope: string;
      }>;
    const remove = db.prepare("DELETE FROM inbound_items WHERE id = ?");
    const update = db.prepare("UPDATE inbound_items SET external_id_hash = ? WHERE id = ?");
    for (const row of rows) {
      let externalId: string;
      try {
        const item = secureStore.decryptJson<{ externalId?: unknown }>(
          row.payload_envelope,
          row.session_id,
          `inbound:${row.id}`,
        );
        if (typeof item.externalId !== "string" || item.externalId.length === 0) {
          throw new Error("payload_missing_external_id");
        }
        externalId = item.externalId;
      } catch {
        remove.run(row.id);
        dropped += 1;
        continue;
      }
      const expected = secureStore.keyedHash(
        externalId,
        `inbound:acct:${row.account_key_hash}:${row.source}`,
      );
      if (expected === row.external_id_hash) continue;
      try {
        update.run(expected, row.id);
        rehashed += 1;
      } catch {
        remove.run(row.id);
        dropped += 1;
      }
    }
    db.pragma(`user_version = ${INBOUND_ACCOUNT_HASHES_READY}`);
  })();
  return { rehashed, dropped };
}
