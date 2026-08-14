import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SecureStore } from "../src/crypto.js";
import {
  completeInboundAccountMigration,
  openDatabase,
  ROLLBACK_SAFE_PLATFORM_EXPIRY_MS,
  type SqliteDatabase,
} from "../src/database.js";
import { DemoRepository } from "../src/repository.js";
import { fakeDm, temporaryDirectory, testConfig } from "./helpers.js";

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

  it("re-keys legacy inbound history to the account dimension without losing dedup", () => {
    const temporary = temporaryDirectory();
    cleanup = temporary.cleanup;
    const path = `${temporary.path}/inbound-account.sqlite`;
    const secureStore = new SecureStore(testConfig().encryptionKey);
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
      CREATE TABLE inbound_items (
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
      CREATE TABLE reply_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
        inbound_item_id TEXT NOT NULL UNIQUE REFERENCES inbound_items(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        output_envelope TEXT,
        model TEXT,
        provider_request_id TEXT,
        platform_client_id TEXT NOT NULL UNIQUE,
        run_generation INTEGER NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO demo_sessions (
        id, created_at, updated_at, expires_at, auth_state, account_key_hash
      ) VALUES ('holder', 1, 1, 2, 'active', 'acct-A')
    `).run();
    legacy.prepare(`
      INSERT INTO demo_sessions (
        id, created_at, updated_at, expires_at, auth_state, account_key_hash
      ) VALUES ('retired', 1, 1, 2, 'logged_out', NULL)
    `).run();
    const liveItem = fakeDm("legacy-live", "finder-legacy", "老容器已答复", 1_000);
    legacy.prepare(`
      INSERT INTO inbound_items (
        id, session_id, source, external_id_hash, payload_envelope,
        occurred_at, discovered_at, historical, reply_eligible
      ) VALUES ('item-live', 'holder', 'dm', ?, ?, 1000, 1000, 0, 1)
    `).run(
      secureStore.keyedHash(liveItem.externalId, "inbound:holder:dm"),
      secureStore.encryptJson(liveItem, "holder", "inbound:item-live"),
    );
    legacy.prepare(`
      INSERT INTO inbound_items (
        id, session_id, source, external_id_hash, payload_envelope,
        occurred_at, discovered_at, historical, reply_eligible
      ) VALUES ('item-dead', 'retired', 'dm', 'dead-hash', 'dead-envelope', 900, 900, 1, 0)
    `).run();
    legacy.prepare(`
      INSERT INTO reply_jobs (
        id, session_id, inbound_item_id, state, platform_client_id,
        run_generation, created_at, updated_at
      ) VALUES ('reply-live', 'holder', 'item-live', 'confirmed', 'client-live', 0, 1000, 1000)
    `).run();
    legacy.prepare(`
      INSERT INTO reply_jobs (
        id, session_id, inbound_item_id, state, platform_client_id,
        run_generation, created_at, updated_at
      ) VALUES ('reply-dead', 'retired', 'item-dead', 'failed', 'client-dead', 0, 900, 900)
    `).run();
    legacy.close();

    database = openDatabase(path);
    // Rows without an owning account are unattributable and leave with the rebuild.
    expect(database.prepare("SELECT id FROM inbound_items").all()).toEqual([{ id: "item-live" }]);
    expect(database.prepare("SELECT id FROM reply_jobs").all()).toEqual([{ id: "reply-live" }]);
    expect(database.pragma("user_version", { simple: true })).toBe(1);

    const migration = completeInboundAccountMigration(database, secureStore);
    expect(migration).toEqual({ rehashed: 1, dropped: 0 });
    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(completeInboundAccountMigration(database, secureStore))
      .toEqual({ rehashed: 0, dropped: 0 });

    const accountHash = secureStore.keyedHash(liveItem.externalId, "inbound:acct:acct-A:dm");
    expect(database.prepare(
      "SELECT external_id_hash AS hash, account_key_hash AS account FROM inbound_items",
    ).get()).toEqual({ hash: accountHash, account: "acct-A" });

    // A successor container re-offering the same platform message must hit the dedup ledger.
    const repository = new DemoRepository(database);
    const holder = repository.getSession("holder");
    if (!holder) throw new Error("missing holder session");
    const reoffer = repository.insertInbound({
      id: randomUUID(),
      accountKeyHash: "acct-A",
      sessionId: "holder",
      source: "dm",
      externalIdHash: accountHash,
      payloadEnvelope: "unused",
      occurredAt: 1_000,
      discoveredAt: Date.now(),
      historical: false,
      replyEligible: true,
      authGeneration: holder.authGeneration,
      runGeneration: holder.runGeneration,
      platformClientId: randomUUID(),
    });
    expect(reoffer).toEqual({ inserted: false, replyId: null });
    expect(repository.getReplyForInbound("item-live")).toMatchObject({ state: "confirmed" });
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
