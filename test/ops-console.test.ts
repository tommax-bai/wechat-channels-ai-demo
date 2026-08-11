import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { SecureStore } from "../src/crypto.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { DemoRepository } from "../src/repository.js";
import { buildServer } from "../src/server.js";
import { SessionService } from "../src/service/session-service.js";
import { FakeWechatGateway, testConfig } from "./helpers.js";

const OPS_PASSWORD = "ops-secret-1";
const OPS_COOKIE = "wechat_demo_session_ops";

describe("ops console access", () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  async function buildApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
    const config = testConfig(overrides);
    database = openDatabase(":memory:");
    const repository = new DemoRepository(database);
    const secureStore = new SecureStore(config.encryptionKey);
    const sessions = new SessionService(config, repository, secureStore, new FakeWechatGateway());
    app = await buildServer({ config, repository, sessions });
    return app;
  }

  it("locks console APIs behind the shared ops password", async () => {
    const server = await buildApp({ opsPassword: OPS_PASSWORD });

    const locked = await server.inject({ method: "GET", url: "/api/sessions" });
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toEqual({ error: "ops_auth_required" });
    const lockedEvents = await server.inject({ method: "GET", url: "/api/events" });
    expect(lockedEvents.statusCode).toBe(401);
    expect(lockedEvents.json()).toEqual({ error: "ops_auth_required" });

    const rejected = await server.inject({
      method: "POST",
      url: "/api/ops/login",
      headers: { origin: "http://localhost:4310" },
      payload: { password: "wrong-password" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "ops_password_invalid" });
    expect(rejected.headers["set-cookie"]).toBeUndefined();

    const accepted = await server.inject({
      method: "POST",
      url: "/api/ops/login",
      headers: { origin: "http://localhost:4310" },
      payload: { password: OPS_PASSWORD },
    });
    expect(accepted.statusCode).toBe(204);
    const setCookie = accepted.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toMatch(new RegExp(`^${OPS_COOKIE}=`));
    expect(raw).toContain("HttpOnly");
    expect(raw).not.toContain(OPS_PASSWORD);
    const opsCookie = raw?.split(";", 1)[0] ?? "";

    const unlocked = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: opsCookie },
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toEqual({ selectedSessionId: null, sessions: [] });

    const forged = await server.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: `${OPS_COOKIE}=forged-value` },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("keeps the connect page and partner API outside the ops gate", async () => {
    const server = await buildApp({
      opsPassword: OPS_PASSWORD,
      funnelBaseUrl: "http://funnel.example.test",
    });

    const page = await server.inject({ method: "GET", url: "/connect" });
    expect(page.statusCode).toBe(200);

    const connect = await server.inject({ method: "GET", url: "/api/connect" });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({ accountBound: false });

    const partner = await server.inject({ method: "GET", url: "/partner/v1/accounts" });
    expect(partner.json()).toEqual({ error: "partner_api_unavailable" });
  });

  it("opens the console without a password when none is configured", async () => {
    const server = await buildApp();
    const response = await server.inject({ method: "GET", url: "/api/sessions" });
    expect(response.statusCode).toBe(200);
  });

  it("does not create a session for a read without one", async () => {
    const server = await buildApp();

    const snapshot = await server.inject({ method: "GET", url: "/api/session" });
    expect(snapshot.statusCode).toBe(401);
    expect(snapshot.json()).toEqual({ error: "demo_session_required" });
    expect(snapshot.headers["set-cookie"]).toBeUndefined();

    const listed = await server.inject({ method: "GET", url: "/api/sessions" });
    expect(listed.statusCode).toBe(200);

    const count = database?.prepare("SELECT COUNT(*) AS count FROM demo_sessions")
      .get() as { count: number } | undefined;
    expect(count?.count).toBe(0);
  });
});
