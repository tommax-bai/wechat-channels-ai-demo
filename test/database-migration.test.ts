import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  ROLLBACK_SAFE_PLATFORM_EXPIRY_MS,
  type SqliteDatabase,
} from "../src/database.js";
import { temporaryDirectory } from "./helpers.js";

describe("authenticated session persistence migration", () => {
  let database: SqliteDatabase | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    database?.close();
    cleanup?.();
  });

  it("promotes an existing authenticated row without replacing its identity", () => {
    const temporary = temporaryDirectory();
    cleanup = temporary.cleanup;
    const path = `${temporary.path}/legacy.sqlite`;
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE demo_sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        auth_state TEXT NOT NULL,
        automation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automation_enabled IN (0, 1)),
        auth_generation INTEGER NOT NULL DEFAULT 0,
        run_generation INTEGER NOT NULL DEFAULT 0,
        account_key_hash TEXT UNIQUE,
        last_error_code TEXT
      );
      CREATE TABLE source_states (
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        baseline_complete INTEGER NOT NULL DEFAULT 0,
        cursor_envelope TEXT,
        last_success_at INTEGER,
        last_error_code TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, source)
      );
    `);
    legacy.prepare(`
      INSERT INTO demo_sessions (
        id, created_at, updated_at, expires_at, auth_state, account_key_hash
      ) VALUES ('existing', 1, 1, 2, 'active', 'account-hash')
    `).run();
    legacy.prepare(`
      INSERT INTO demo_sessions (
        id, created_at, updated_at, expires_at, auth_state, account_key_hash
      ) VALUES ('fresh', 2, 2, 3, 'baseline_sync', NULL)
    `).run();
    legacy.prepare(`
      INSERT INTO source_states (
        session_id, source, state, baseline_complete, cursor_envelope,
        last_success_at, last_error_code, updated_at
      ) VALUES ('existing', 'comment', 'healthy', 1, 'cursor', 1, NULL, 1)
    `).run();
    legacy.prepare(`
      INSERT INTO source_states (
        session_id, source, state, baseline_complete, cursor_envelope,
        last_success_at, last_error_code, updated_at
      ) VALUES ('fresh', 'comment', 'pending', 0, NULL, NULL, NULL, 2)
    `).run();
    legacy.close();

    database = openDatabase(path);
    const migrated = database.prepare(`
      SELECT platform_persistent AS persistent, expires_at AS expiresAt,
             account_key_hash AS accountKeyHash, reply_provider AS replyProvider,
             funnel_job_number AS funnelJobNumber
      FROM demo_sessions WHERE id = 'existing'
    `).get() as {
      persistent: number;
      expiresAt: number;
      accountKeyHash: string;
      replyProvider: string;
      funnelJobNumber: string | null;
    };

    expect(migrated).toEqual({
      persistent: 1,
      expiresAt: ROLLBACK_SAFE_PLATFORM_EXPIRY_MS,
      accountKeyHash: "account-hash",
      replyProvider: "chat-llm",
      funnelJobNumber: null,
    });
    expect(database.prepare("PRAGMA table_info(account_qr_assets)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "session_id", pk: 1 }),
        expect.objectContaining({ name: "envelope", notnull: 1 }),
        expect.objectContaining({ name: "mime_type", notnull: 1 }),
        expect.objectContaining({ name: "byte_length", notnull: 1 }),
        expect.objectContaining({ name: "updated_at", notnull: 1 }),
      ]));
    expect(database.prepare("PRAGMA table_info(demo_sessions)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "linked_session_id", notnull: 0 }),
      ]));
    expect(database.prepare(`
      SELECT last_attempt_at AS lastAttemptAt
      FROM source_states WHERE session_id = 'existing' AND source = 'comment'
    `).get()).toEqual({ lastAttemptAt: 1 });
    expect(database.prepare(`
      SELECT last_attempt_at AS lastAttemptAt
      FROM source_states WHERE session_id = 'fresh' AND source = 'comment'
    `).get()).toEqual({ lastAttemptAt: null });

    // A retained authenticated row cannot know its true login time, so the migration moment
    // stands in as its reply anchor; a row that never authenticated waits for its first login.
    const migrationStart = Date.now() - 60_000;
    const anchored = database.prepare(
      "SELECT last_login_at AS value FROM demo_sessions WHERE id = 'existing'",
    ).get() as { value: number | null };
    expect(anchored.value).toBeGreaterThanOrEqual(migrationStart);
    expect(database.prepare(
      "SELECT last_login_at AS value FROM demo_sessions WHERE id = 'fresh'",
    ).get()).toEqual({ value: null });
  });

  it("creates the account QR table idempotently and cascades account deletion", () => {
    const temporary = temporaryDirectory();
    cleanup = temporary.cleanup;
    const path = `${temporary.path}/account-qr.sqlite`;
    database = openDatabase(path);
    database.prepare(`
      INSERT INTO demo_sessions (
        id, created_at, updated_at, expires_at, auth_state, automation_enabled
      ) VALUES ('account-1', 1, 1, 100, 'new', 0)
    `).run();
    database.prepare(`
      INSERT INTO account_qr_assets (
        session_id, envelope, mime_type, byte_length, updated_at
      ) VALUES ('account-1', 'encrypted-envelope', 'image/png', 8, 2)
    `).run();
    database.close();

    database = openDatabase(path);
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_qr_assets").get())
      .toEqual({ count: 1 });
    database.prepare("DELETE FROM demo_sessions WHERE id = 'account-1'").run();
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_qr_assets").get())
      .toEqual({ count: 0 });
  });
});
