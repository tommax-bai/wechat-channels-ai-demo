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
  });
});
