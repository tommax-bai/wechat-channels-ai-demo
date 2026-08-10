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
      auth_generation INTEGER NOT NULL DEFAULT 0,
      run_generation INTEGER NOT NULL DEFAULT 0,
      account_key_hash TEXT UNIQUE,
      linked_session_id TEXT,
      last_error_code TEXT
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
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, source)
    );

    CREATE TABLE IF NOT EXISTS inbound_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('dm', 'comment')),
      external_id_hash TEXT NOT NULL,
      payload_envelope TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      discovered_at INTEGER NOT NULL,
      historical INTEGER NOT NULL CHECK (historical IN (0, 1)),
      reply_eligible INTEGER NOT NULL CHECK (reply_eligible IN (0, 1)),
      UNIQUE (session_id, source, external_id_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_inbound_session_time
      ON inbound_items(session_id, discovered_at DESC);

    CREATE INDEX IF NOT EXISTS idx_inbound_session_source_time_id
      ON inbound_items(session_id, source, discovered_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS reply_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
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
  if (!sessionColumns.some((column) => column.name === "linked_session_id")) {
    db.exec("ALTER TABLE demo_sessions ADD COLUMN linked_session_id TEXT");
  }
  const sourceColumns = db.pragma("table_info(source_states)") as Array<{ name: string }>;
  if (!sourceColumns.some((column) => column.name === "last_attempt_at")) {
    db.exec("ALTER TABLE source_states ADD COLUMN last_attempt_at INTEGER");
  }
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
  return db;
}
