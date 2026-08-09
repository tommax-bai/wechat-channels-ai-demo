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
    `);
    legacy.prepare(`
      INSERT INTO demo_sessions (
        id, created_at, updated_at, expires_at, auth_state, account_key_hash
      ) VALUES ('existing', 1, 1, 2, 'active', 'account-hash')
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
