import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { SecureStore } from "../src/crypto.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { DemoRepository } from "../src/repository.js";
import { DEFAULT_FUNNEL_JOB_NUMBER } from "../src/reply-defaults.js";
import { buildServer } from "../src/server.js";
import { SessionService } from "../src/service/session-service.js";
import { WorkerCoordinator } from "../src/service/workers.js";
import type {
  InboundSource,
  NormalizedInboundItem,
  ReplyModelResult,
} from "../src/types.js";
import type {
  LoginPollResult,
  PendingWechatLogin,
} from "../src/wechat/client.js";
import {
  FakeReplyModel,
  FakeWechatGateway,
  fakeComment,
  fakeDm,
  testConfig,
} from "./helpers.js";

const PARTNER_KEY = "partner-api-test-key-1234567890abcdef";
const WRONG_PARTNER_KEY = "wrong-partner-api-key-1234567890abc";
const CONCRETE_MODEL = "doubao-seed-character-260628";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;

interface AccountProjection {
  accountId: string;
  accountDisplayName: string | null;
  login: {
    state: string;
    scanned: boolean;
    succeeded: boolean;
    qrDataUrl: string | null;
    qrExpiresAt: string | null;
  };
  hosting: {
    state: string;
    automationEnabled: boolean;
    automationEffective: boolean;
    loginExpired: boolean;
    reloginRequired: boolean;
    credentialExpiresAt: string | null;
  };
  replySettings: {
    provider: "chat-llm" | "funnel";
    providerConfigured: boolean;
    jobNumber: string | null;
  };
  wechatQr: {
    configured: boolean;
    mimeType: "image/png" | "image/jpeg" | null;
    byteLength: number | null;
    updatedAt: string | null;
  };
}

interface LoginProjection {
  accountId: string;
  accountDisplayName: string | null;
  login: AccountProjection["login"];
}

interface ContentItem {
  id: string;
  source: InboundSource;
  authorName: string;
  text: string;
  historical: boolean;
  replyEligible: boolean;
  reply: {
    state: string;
    text: string | null;
    messages: string[];
    errorCode: string | null;
    updatedAt: string;
  } | null;
}

interface ContentPage {
  items: ContentItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface TestFixture {
  app: FastifyInstance;
  database: SqliteDatabase;
  repository: DemoRepository;
  secureStore: SecureStore;
  gateway: ScriptedWechatGateway;
  workers: WorkerCoordinator;
}

const fixtures: TestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.database.close();
  }
});

describe("Partner API", () => {
  it("returns 503 when the Partner API is not configured", async () => {
    const fixture = await createFixture(false);
    const response = await fixture.app.inject({
      method: "GET",
      url: "/partner/v1/capabilities",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "partner_api_unavailable" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("requires the configured Bearer key and returns only safe capabilities", async () => {
    const fixture = await createFixture();
    const missing = await fixture.app.inject({
      method: "GET",
      url: "/partner/v1/capabilities",
      headers: { cookie: "wechat_demo_session=browser-cookie-is-not-auth" },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: "partner_api_unauthorized" });
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expectPartnerHeaders(missing.headers);

    const wrong = await fixture.app.inject({
      method: "GET",
      url: "/partner/v1/capabilities",
      headers: partnerHeaders(WRONG_PARTNER_KEY),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "partner_api_unauthorized" });
    expect(wrong.headers["www-authenticate"]).toBe("Bearer");
    expectPartnerHeaders(wrong.headers);

    const valid = await fixture.app.inject({
      method: "GET",
      url: "/partner/v1/capabilities",
      headers: partnerHeaders(),
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({
      apiVersion: "v1",
      providers: [
        {
          id: "chat-llm",
          displayName: "CHAT回复",
          configured: true,
          requiresJobNumber: false,
        },
        {
          id: "funnel",
          displayName: "招聘接口",
          configured: true,
          requiresJobNumber: true,
        },
      ],
      jobSelection: {
        mode: "known_job_number",
        catalogueAvailable: false,
      },
    });
    expectPartnerHeaders(valid.headers);
    expect(valid.headers["access-control-allow-origin"]).toBeUndefined();
    expect(valid.body).not.toContain(PARTNER_KEY);
    expect(valid.body).not.toContain(CONCRETE_MODEL);
    expect(valid.body).not.toContain("funnel.example.test");

    const malformedJson = await fixture.app.inject({
      method: "POST",
      url: "/partner/v1/accounts",
      headers: {
        ...partnerHeaders(),
        "content-type": "application/json",
      },
      payload: "{",
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toEqual({ error: "invalid_request" });
  });

  it("creates, lists, resolves, and deletes explicit Partner accounts", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/partner/v1/accounts",
      headers: partnerHeaders(),
    });

    expect(created.statusCode).toBe(201);
    expectPartnerHeaders(created.headers);
    const account = created.json<AccountProjection>();
    expect(account.accountId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(account).toMatchObject({
      accountDisplayName: null,
      login: {
        state: "not_requested",
        scanned: false,
        succeeded: false,
        qrDataUrl: null,
        qrExpiresAt: null,
      },
      hosting: {
        state: "not_ready",
        automationEnabled: true,
        automationEffective: false,
        loginExpired: false,
        reloginRequired: false,
        credentialExpiresAt: null,
      },
      replySettings: {
        provider: "funnel",
        providerConfigured: true,
        jobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
      },
      wechatQr: {
        configured: false,
        mimeType: null,
        byteLength: null,
        updatedAt: null,
      },
    });

    const listed = await fixture.app.inject({
      method: "GET",
      url: "/partner/v1/accounts",
      headers: partnerHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: AccountProjection[] }>().items)
      .toEqual([expect.objectContaining({ accountId: account.accountId })]);

    const fetched = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}`,
      headers: partnerHeaders(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<AccountProjection>().accountId).toBe(account.accountId);

    const unknownId = "A".repeat(43);
    const unknown = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${unknownId}`,
      headers: partnerHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "partner_account_not_found" });

    const deleted = await fixture.app.inject({
      method: "DELETE",
      url: `/partner/v1/accounts/${account.accountId}`,
      headers: partnerHeaders(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expectPartnerHeaders(deleted.headers);

    const afterDelete = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}`,
      headers: partnerHeaders(),
    });
    expect(afterDelete.statusCode).toBe(404);
    expect(afterDelete.json()).toEqual({ error: "partner_account_not_found" });
  });

  it("rejects Partner account creation before persistence when Funnel is unavailable", async () => {
    const fixture = await createFixture(true, false);
    const created = await fixture.app.inject({
      method: "POST",
      url: "/partner/v1/accounts",
      headers: partnerHeaders(),
    });

    expect(created.statusCode).toBe(503);
    expect(created.json()).toEqual({ error: "funnel_provider_unavailable" });
    expect(fixture.repository.listRetainedSessions(Date.now())).toEqual([]);
  });

  it("keeps ordinary browser-created sessions on the existing CHAT defaults", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/sessions/new",
      headers: { origin: "http://localhost:4310" },
      payload: {},
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      automationEnabled: true,
      replyProvider: "chat-llm",
      funnelJobNumber: null,
    });
  });

  it("stores separate encrypted account QR assets and never exposes bytes to Partner clients", async () => {
    const fixture = await createFixture();
    const first = await createAccount(fixture.app);
    const second = await createAccount(fixture.app);

    const initial = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      accountId: first.accountId,
      wechatQr: {
        configured: false,
        mimeType: null,
        byteLength: null,
        updatedAt: null,
      },
    });

    const configured = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
      payload: { dataUrl: PNG_DATA_URL },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      accountId: first.accountId,
      wechatQr: {
        configured: true,
        mimeType: "image/png",
        byteLength: PNG_BYTES.byteLength,
      },
    });
    expect(configured.json<{ wechatQr: { updatedAt: string } }>().wechatQr.updatedAt)
      .toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(configured.body).not.toContain("dataUrl");
    expect(configured.body).not.toContain(PNG_BYTES.toString("base64"));

    const encrypted = fixture.database.prepare(`
      SELECT envelope, mime_type AS mimeType, byte_length AS byteLength
      FROM account_qr_assets WHERE session_id = ?
    `).get(first.accountId) as {
      envelope: string;
      mimeType: string;
      byteLength: number;
    };
    expect(encrypted).toMatchObject({
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
    });
    expect(encrypted.envelope).not.toContain(PNG_BYTES.toString("base64"));
    expect(fixture.secureStore.decryptJson(
      encrypted.envelope,
      first.accountId,
      "account-wechat-qr",
    )).toEqual({
      version: 1,
      mimeType: "image/png",
      dataBase64: PNG_BYTES.toString("base64"),
    });

    const firstProjection = await getAccount(fixture.app, first.accountId);
    expect(firstProjection.wechatQr).toMatchObject({
      configured: true,
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
    });
    expect(JSON.stringify(firstProjection)).not.toContain(PNG_BYTES.toString("base64"));
    expect((await getAccount(fixture.app, second.accountId)).wechatQr)
      .toEqual({ configured: false, mimeType: null, byteLength: null, updatedAt: null });

    const invalidReplacement = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
      payload: {
        dataUrl: `data:image/jpeg;base64,${PNG_BYTES.toString("base64")}`,
      },
    });
    expect(invalidReplacement.statusCode).toBe(400);
    expect(invalidReplacement.json()).toEqual({ error: "account_wechat_qr_invalid" });
    expect((await getAccount(fixture.app, first.accountId)).wechatQr.mimeType)
      .toBe("image/png");

    const bodyLimitOversizedReplacement = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
      payload: { dataUrl: bodyLimitOversizedDataUrl() },
    });
    expect(bodyLimitOversizedReplacement.statusCode).toBe(400);
    expect(bodyLimitOversizedReplacement.json()).toEqual({
      error: "account_wechat_qr_too_large",
    });
    expect((await getAccount(fixture.app, first.accountId)).wechatQr.mimeType)
      .toBe("image/png");

    const oversizedPng = Buffer.alloc(512 * 1_024 + 1);
    PNG_BYTES.copy(oversizedPng);
    const oversizedReplacement = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
      payload: {
        dataUrl: `data:image/png;base64,${oversizedPng.toString("base64")}`,
      },
    });
    expect(oversizedReplacement.statusCode).toBe(400);
    expect(oversizedReplacement.json()).toEqual({
      error: "account_wechat_qr_too_large",
    });
    expect((await getAccount(fixture.app, first.accountId)).wechatQr.mimeType)
      .toBe("image/png");

    const replaced = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
      payload: { dataUrl: JPEG_DATA_URL },
    });
    expect(replaced.json()).toMatchObject({
      accountId: first.accountId,
      wechatQr: {
        configured: true,
        mimeType: "image/jpeg",
        byteLength: JPEG_BYTES.byteLength,
      },
    });

    const removed = await fixture.app.inject({
      method: "DELETE",
      url: `/partner/v1/accounts/${first.accountId}/wechat-qr`,
      headers: partnerHeaders(),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({
      accountId: first.accountId,
      wechatQr: {
        configured: false,
        mimeType: null,
        byteLength: null,
        updatedAt: null,
      },
    });
    expect((await getAccount(fixture.app, second.accountId)).wechatQr.configured)
      .toBe(false);
  });

  it("returns the selected Demo account QR preview only from the same-origin Demo API", async () => {
    const fixture = await createFixture();
    const firstBootstrap = await fixture.app.inject({
      method: "POST",
      url: "/api/sessions/new",
      headers: { origin: "http://localhost:4310" },
      payload: {},
    });
    const firstCookie = requireCookie(firstBootstrap.headers["set-cookie"]);
    const firstAccountId = firstBootstrap.json<{ sessionId: string }>().sessionId;
    expect(firstBootstrap.json<{ wechatQr: unknown }>().wechatQr).toEqual({
      configured: false,
      mimeType: null,
      byteLength: null,
      updatedAt: null,
    });
    const secondBootstrap = await fixture.app.inject({
      method: "POST",
      url: "/api/sessions/new",
      headers: { origin: "http://localhost:4310" },
      payload: {},
    });
    const secondCookie = requireCookie(secondBootstrap.headers["set-cookie"]);
    const secondAccountId = secondBootstrap.json<{ sessionId: string }>().sessionId;

    const missingTarget = await fixture.app.inject({
      method: "PUT",
      url: "/api/session/wechat-qr",
      headers: { cookie: secondCookie, origin: "http://localhost:4310" },
      payload: { dataUrl: PNG_DATA_URL },
    });
    expect(missingTarget.statusCode).toBe(400);
    expect(missingTarget.json()).toEqual({ error: "demo_account_target_required" });

    const crossOrigin = await fixture.app.inject({
      method: "PUT",
      url: "/api/session/wechat-qr",
      headers: {
        cookie: secondCookie,
        origin: "https://attacker.example",
        "x-demo-account-id": firstAccountId,
      },
      payload: { dataUrl: PNG_DATA_URL },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const configured = await fixture.app.inject({
      method: "PUT",
      url: "/api/session/wechat-qr",
      headers: {
        cookie: secondCookie,
        origin: "http://localhost:4310",
        "x-demo-account-id": firstAccountId,
      },
      payload: { dataUrl: PNG_DATA_URL },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      accountId: firstAccountId,
      wechatQr: {
        configured: true,
        mimeType: "image/png",
        byteLength: PNG_BYTES.byteLength,
        dataUrl: PNG_DATA_URL,
      },
    });

    const bodyLimitOversizedReplacement = await fixture.app.inject({
      method: "PUT",
      url: "/api/session/wechat-qr",
      headers: {
        cookie: secondCookie,
        origin: "http://localhost:4310",
        "x-demo-account-id": firstAccountId,
      },
      payload: { dataUrl: bodyLimitOversizedDataUrl() },
    });
    expect(bodyLimitOversizedReplacement.statusCode).toBe(400);
    expect(bodyLimitOversizedReplacement.json()).toEqual({
      error: "account_wechat_qr_too_large",
    });

    const preview = await fixture.app.inject({
      method: "GET",
      url: "/api/session/wechat-qr",
      headers: { cookie: secondCookie, "x-demo-account-id": firstAccountId },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{
      accountId: string;
      wechatQr: { dataUrl: string };
    }>().wechatQr.dataUrl).toBe(PNG_DATA_URL);

    const untouched = await fixture.app.inject({
      method: "GET",
      url: "/api/session/wechat-qr",
      headers: { cookie: firstCookie, "x-demo-account-id": secondAccountId },
    });
    expect(untouched.json()).toEqual({
      accountId: secondAccountId,
      wechatQr: {
        configured: false,
        mimeType: null,
        byteLength: null,
        updatedAt: null,
        dataUrl: null,
      },
    });

    const removed = await fixture.app.inject({
      method: "DELETE",
      url: "/api/session/wechat-qr",
      headers: {
        cookie: secondCookie,
        origin: "http://localhost:4310",
        "x-demo-account-id": firstAccountId,
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({
      accountId: firstAccountId,
      wechatQr: {
        configured: false,
        mimeType: null,
        byteLength: null,
        updatedAt: null,
        dataUrl: null,
      },
    });
  });

  it("distinguishes QR availability, scan detection, login success, and active relogin conflicts", async () => {
    const fixture = await createFixture();
    const temporarilyUnavailable = await createAccount(fixture.app);
    fixture.gateway.loginCreateError = new Error("private_upstream_detail");
    const unavailable = await fixture.app.inject({
      method: "POST",
      url: `/partner/v1/accounts/${temporarilyUnavailable.accountId}/login/qr`,
      headers: partnerHeaders(),
    });
    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json()).toEqual({ error: "partner_login_qr_unavailable" });
    expect(unavailable.body).not.toContain("private_upstream_detail");
    expect((await getAccount(fixture.app, temporarilyUnavailable.accountId)).login.state)
      .toBe("not_requested");
    fixture.gateway.loginCreateError = null;

    const account = await createAccount(fixture.app);
    fixture.gateway.loginPollStates.push("scanned");

    const enabled = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${account.accountId}/hosting`,
      headers: partnerHeaders(),
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);

    const qr = await fixture.app.inject({
      method: "POST",
      url: `/partner/v1/accounts/${account.accountId}/login/qr`,
      headers: partnerHeaders(),
    });
    expect(qr.statusCode).toBe(200);
    expect(qr.json<AccountProjection>().login).toMatchObject({
      state: "waiting_scan",
      scanned: false,
      succeeded: false,
    });
    expect(qr.json<AccountProjection>().login.qrDataUrl)
      .toMatch(/^data:image\/png;base64,/);
    expect(qr.json<AccountProjection>().login.qrExpiresAt)
      .toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await fixture.workers.runOnce();
    const scanned = await getLogin(fixture.app, account.accountId);
    expect(scanned.login).toMatchObject({
      state: "scanned",
      scanned: true,
      succeeded: false,
      qrDataUrl: null,
      qrExpiresAt: null,
    });

    const inProgressRelogin = await fixture.app.inject({
      method: "POST",
      url: `/partner/v1/accounts/${account.accountId}/login/qr`,
      headers: partnerHeaders(),
    });
    expect(inProgressRelogin.statusCode).toBe(409);
    expect(inProgressRelogin.json()).toEqual({ error: "login_in_progress" });

    await fixture.workers.runOnce();
    const succeeded = await getLogin(fixture.app, account.accountId);
    expect(succeeded.accountDisplayName).toBeTruthy();
    expect(succeeded.login).toMatchObject({
      state: "succeeded",
      scanned: true,
      succeeded: true,
      qrDataUrl: null,
      qrExpiresAt: null,
    });
    expectNoSensitiveKeys(succeeded);

    const hosting = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/hosting`,
      headers: partnerHeaders(),
    });
    expect(hosting.statusCode).toBe(200);
    expect(hosting.json()).toMatchObject({
      hosting: {
        state: "active",
        automationEnabled: true,
        automationEffective: true,
        loginExpired: false,
        credentialExpiresAt: null,
      },
    });

    const activeRelogin = await fixture.app.inject({
      method: "POST",
      url: `/partner/v1/accounts/${account.accountId}/login/qr`,
      headers: partnerHeaders(),
    });
    expect(activeRelogin.statusCode).toBe(409);
    expect(activeRelogin.json()).toEqual({ error: "account_already_hosted" });

    const failedBeforeLogin = await createAccount(fixture.app);
    await requestQr(fixture.app, failedBeforeLogin.accountId);
    const pending = fixture.repository.getSession(failedBeforeLogin.accountId);
    if (!pending) throw new Error("missing pending login fixture");
    expect(fixture.repository.setAuthStateIfGeneration(
      pending.id,
      pending.authGeneration,
      "auth_required",
      "wechat_network_error",
      Date.now(),
    )).toBe(true);
    const failedProjection = await getAccount(fixture.app, pending.id);
    expect(failedProjection.login).toMatchObject({
      state: "failed",
      scanned: false,
      succeeded: false,
      errorCode: "wechat_network_error",
    });
    expect(failedProjection.hosting).toMatchObject({
      state: "not_ready",
      loginExpired: false,
      reloginRequired: false,
    });

    const schemaFailure = await createAccount(fixture.app);
    await requestQr(fixture.app, schemaFailure.accountId);
    const schemaPending = fixture.repository.getSession(schemaFailure.accountId);
    if (!schemaPending) throw new Error("missing schema failure fixture");
    expect(fixture.repository.setAuthStateIfGeneration(
      schemaPending.id,
      schemaPending.authGeneration,
      "schema_changed",
      "schema_changed_login_shape",
      Date.now(),
    )).toBe(true);
    const schemaProjection = await getAccount(fixture.app, schemaPending.id);
    expect(schemaProjection.login).toMatchObject({
      state: "failed",
      scanned: false,
      succeeded: false,
    });
    expect(schemaProjection.hosting).toMatchObject({
      state: "not_ready",
      loginExpired: false,
    });
    const schemaRetry = await fixture.app.inject({
      method: "POST",
      url: `/partner/v1/accounts/${schemaPending.id}/login/qr`,
      headers: partnerHeaders(),
    });
    expect(schemaRetry.statusCode).toBe(200);
    expect(schemaRetry.json<AccountProjection>().login.state).toBe("waiting_scan");
  });

  it("selects reply provider and job, controls hosting, and reports platform expiry", async () => {
    const fixture = await createFixture();
    const account = await createAccount(fixture.app);

    const missingJob = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${account.accountId}/reply-settings`,
      headers: partnerHeaders(),
      payload: { provider: "funnel", jobNumber: "   " },
    });
    expect(missingJob.statusCode).toBe(400);
    expect(missingJob.json()).toEqual({ error: "funnel_job_number_required" });

    const unchanged = await getAccount(fixture.app, account.accountId);
    expect(unchanged.replySettings).toMatchObject({
      provider: "funnel",
      jobNumber: DEFAULT_FUNNEL_JOB_NUMBER,
    });

    const selected = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${account.accountId}/reply-settings`,
      headers: partnerHeaders(),
      payload: { provider: "funnel", jobNumber: "  job-42  " },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json<AccountProjection>().replySettings).toEqual({
      provider: "funnel",
      providerConfigured: true,
      jobNumber: "job-42",
    });

    const invalidHosting = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${account.accountId}/hosting`,
      headers: partnerHeaders(),
      payload: { enabled: "true" },
    });
    expect(invalidHosting.statusCode).toBe(400);
    expect(invalidHosting.json()).toEqual({ error: "invalid_request" });

    const enabled = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${account.accountId}/hosting`,
      headers: partnerHeaders(),
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<AccountProjection>().hosting).toMatchObject({
      state: "not_ready",
      automationEnabled: true,
      automationEffective: false,
    });

    await requestQr(fixture.app, account.accountId);
    await fixture.workers.runOnce();
    expect((await getAccount(fixture.app, account.accountId)).hosting).toMatchObject({
      state: "active",
      automationEnabled: true,
      automationEffective: true,
      loginExpired: false,
    });

    const paused = await fixture.app.inject({
      method: "PUT",
      url: `/partner/v1/accounts/${account.accountId}/hosting`,
      headers: partnerHeaders(),
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<AccountProjection>().hosting).toMatchObject({
      state: "paused",
      automationEnabled: false,
      automationEffective: false,
      loginExpired: false,
    });

    const persisted = fixture.repository.getSession(account.accountId);
    if (!persisted) throw new Error("missing Partner account");
    expect(fixture.repository.setAuthStateIfGeneration(
      account.accountId,
      persisted.authGeneration,
      "auth_required",
      "auth_required",
      Date.now(),
    )).toBe(true);
    const expired = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/hosting`,
      headers: partnerHeaders(),
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toMatchObject({
      hosting: {
        state: "expired",
        loginExpired: true,
        reloginRequired: true,
        credentialExpiresAt: null,
      },
    });
  });

  it("separates comments and direct messages with scoped keyset cursors and safe reply output", async () => {
    const fixture = await createFixture();
    const account = await createAccount(fixture.app);
    const discoveredAt = Date.now() - 10_000;
    const commentIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ] as const;
    insertInbound(
      fixture,
      account.accountId,
      { ...fakeComment("platform-comment-secret-1", "评论一"), occurredAt: discoveredAt },
      discoveredAt,
      false,
      commentIds[0],
    );
    insertInbound(
      fixture,
      account.accountId,
      { ...fakeComment("platform-comment-secret-2", "评论二"), occurredAt: discoveredAt },
      discoveredAt,
      false,
      commentIds[1],
    );
    insertInbound(
      fixture,
      account.accountId,
      { ...fakeComment("platform-comment-secret-3", "评论三"), occurredAt: discoveredAt },
      discoveredAt,
      false,
      commentIds[2],
    );

    insertInbound(
      fixture,
      account.accountId,
      {
        ...fakeDm("platform-dm-secret-1", "own-finder-secret", "普通私信"),
        occurredAt: discoveredAt + 1,
      },
      discoveredAt + 1,
      false,
      "11111111-1111-4111-8111-111111111111",
    );
    const replied = insertInbound(
      fixture,
      account.accountId,
      {
        ...fakeDm("platform-dm-secret-2", "own-finder-secret", "需要分段回复"),
        occurredAt: discoveredAt + 2,
      },
      discoveredAt + 2,
      true,
      "22222222-2222-4222-8222-222222222222",
    );
    if (!replied.replyId) throw new Error("missing reply fixture");
    const output: ReplyModelResult = {
      text: "第一条\n第二条",
      messages: ["第一条", "第二条"],
      disposition: "reply",
      model: CONCRETE_MODEL,
      requestId: "embedded-upstream-request-secret",
    };
    expect(fixture.repository.updateReply(
      replied.replyId,
      account.accountId,
      "confirmed",
      {
        outputEnvelope: fixture.secureStore.encryptJson(
          output,
          account.accountId,
          `reply:${replied.replyId}`,
        ),
        model: CONCRETE_MODEL,
        providerRequestId: "stored-upstream-request-secret",
      },
      discoveredAt + 3,
    )).toBe(true);

    const actionOnly = insertInbound(
      fixture,
      account.accountId,
      {
        ...fakeDm("platform-dm-secret-3", "own-finder-secret", "只发二维码"),
        occurredAt: discoveredAt + 4,
      },
      discoveredAt + 4,
      true,
      "33333333-3333-4333-8333-333333333333",
    );
    if (!actionOnly.replyId) throw new Error("missing action-only reply fixture");
    expect(fixture.repository.updateReply(
      actionOnly.replyId,
      account.accountId,
      "confirmed",
      {
        outputEnvelope: fixture.secureStore.encryptJson(
          {
            text: "",
            messages: [],
            disposition: "reply",
            action: "send_wechat_qr",
            model: CONCRETE_MODEL,
          } satisfies ReplyModelResult,
          account.accountId,
          `reply:${actionOnly.replyId}`,
        ),
        model: CONCRETE_MODEL,
      },
      discoveredAt + 5,
    )).toBe(true);

    const first = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/comments?limit=2`,
      headers: partnerHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<ContentPage>();
    expect(firstPage.items.map((item) => item.id)).toEqual([
      commentIds[2],
      commentIds[1],
    ]);
    expect(firstPage.items.every((item) => item.source === "comment")).toBe(true);
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.nextCursor).toBeTruthy();

    const second = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/comments?limit=2&cursor=${encodeURIComponent(requireCursor(firstPage))}`,
      headers: partnerHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondPage = second.json<ContentPage>();
    expect(secondPage.items.map((item) => item.id)).toEqual([commentIds[0]]);
    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size)
      .toBe(3);

    const directMessages = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/direct-messages?limit=10`,
      headers: partnerHeaders(),
    });
    expect(directMessages.statusCode).toBe(200);
    const dmPage = directMessages.json<ContentPage>();
    expect(dmPage.items).toHaveLength(3);
    expect(dmPage.items.every((item) => item.source === "dm")).toBe(true);
    expect(dmPage.items.find((item) => item.text === "需要分段回复")?.reply)
      .toEqual({
        state: "confirmed",
        text: "第一条\n第二条",
        messages: ["第一条", "第二条"],
        errorCode: null,
        updatedAt: new Date(discoveredAt + 3).toISOString(),
      });
    expect(dmPage.items.find((item) => item.text === "只发二维码")?.reply)
      .toEqual({
        state: "confirmed",
        text: "",
        messages: [],
        errorCode: null,
        updatedAt: new Date(discoveredAt + 5).toISOString(),
      });

    const serializedContent = JSON.stringify({ firstPage, secondPage, dmPage });
    for (const hiddenValue of [
      CONCRETE_MODEL,
      "platform-comment-secret",
      "platform-dm-secret",
      "own-finder-secret",
      "embedded-upstream-request-secret",
      "stored-upstream-request-secret",
    ]) {
      expect(serializedContent).not.toContain(hiddenValue);
    }
    expectNoSensitiveKeys({ firstPage, secondPage, dmPage });

    const cursorOnWrongSource = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/direct-messages?cursor=${encodeURIComponent(requireCursor(firstPage))}`,
      headers: partnerHeaders(),
    });
    expect(cursorOnWrongSource.statusCode).toBe(400);
    expect(cursorOnWrongSource.json()).toEqual({ error: "invalid_cursor" });

    const nonCanonicalCursor = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/comments?cursor=${encodeURIComponent(`${requireCursor(firstPage)}!!!`)}`,
      headers: partnerHeaders(),
    });
    expect(nonCanonicalCursor.statusCode).toBe(400);
    expect(nonCanonicalCursor.json()).toEqual({ error: "invalid_cursor" });

    const emptyCursor = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${account.accountId}/comments?cursor=`,
      headers: partnerHeaders(),
    });
    expect(emptyCursor.statusCode).toBe(400);
    expect(emptyCursor.json()).toEqual({ error: "invalid_cursor" });

    const otherAccount = await createAccount(fixture.app);
    const cursorOnWrongAccount = await fixture.app.inject({
      method: "GET",
      url: `/partner/v1/accounts/${otherAccount.accountId}/comments?cursor=${encodeURIComponent(requireCursor(firstPage))}`,
      headers: partnerHeaders(),
    });
    expect(cursorOnWrongAccount.statusCode).toBe(400);
    expect(cursorOnWrongAccount.json()).toEqual({ error: "invalid_cursor" });
  });
});

class ScriptedWechatGateway extends FakeWechatGateway {
  readonly loginPollStates: Array<"waiting" | "scanned"> = [];
  loginCreateError: Error | null = null;

  override async createLogin(qrTtlMs: number): Promise<PendingWechatLogin> {
    if (this.loginCreateError) throw this.loginCreateError;
    return super.createLogin(qrTtlMs);
  }

  override async pollLogin(pending: PendingWechatLogin): Promise<LoginPollResult> {
    const state = this.loginPollStates.shift();
    if (state) return { state, pending };
    return super.pollLogin(pending);
  }
}

async function createFixture(
  partnerApiEnabled = true,
  funnelEnabled = true,
): Promise<TestFixture> {
  const config = configuredTestConfig(partnerApiEnabled, funnelEnabled);
  const database = openDatabase(":memory:");
  const repository = new DemoRepository(database);
  const secureStore = new SecureStore(config.encryptionKey);
  const gateway = new ScriptedWechatGateway();
  const sessions = new SessionService(config, repository, secureStore, gateway);
  const workers = new WorkerCoordinator(
    config,
    repository,
    secureStore,
    gateway,
    {
      "chat-llm": new FakeReplyModel(),
      funnel: new FakeReplyModel(),
    },
  );
  const app = await buildServer({ config, repository, sessions });
  const fixture = { app, database, repository, secureStore, gateway, workers };
  fixtures.push(fixture);
  return fixture;
}

function configuredTestConfig(
  partnerApiEnabled: boolean,
  funnelEnabled: boolean,
): AppConfig {
  return testConfig({
    ...(funnelEnabled ? { funnelBaseUrl: "http://funnel.example.test" } : {}),
    ...(partnerApiEnabled ? { partnerApiKey: PARTNER_KEY } : {}),
  });
}

function partnerHeaders(key = PARTNER_KEY): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

function requireCookie(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const cookie = raw?.split(";", 1)[0];
  if (!cookie) throw new Error("missing Demo session cookie");
  return cookie;
}

function expectPartnerHeaders(headers: OutgoingHttpHeaders): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["set-cookie"]).toBeUndefined();
}

async function createAccount(app: FastifyInstance): Promise<AccountProjection> {
  const response = await app.inject({
    method: "POST",
    url: "/partner/v1/accounts",
    headers: partnerHeaders(),
  });
  expect(response.statusCode).toBe(201);
  return response.json<AccountProjection>();
}

async function getAccount(
  app: FastifyInstance,
  accountId: string,
): Promise<AccountProjection> {
  const response = await app.inject({
    method: "GET",
    url: `/partner/v1/accounts/${accountId}`,
    headers: partnerHeaders(),
  });
  expect(response.statusCode).toBe(200);
  return response.json<AccountProjection>();
}

async function getLogin(
  app: FastifyInstance,
  accountId: string,
): Promise<LoginProjection> {
  const response = await app.inject({
    method: "GET",
    url: `/partner/v1/accounts/${accountId}/login/status`,
    headers: partnerHeaders(),
  });
  expect(response.statusCode).toBe(200);
  return response.json<LoginProjection>();
}

async function requestQr(app: FastifyInstance, accountId: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/partner/v1/accounts/${accountId}/login/qr`,
    headers: partnerHeaders(),
  });
  expect(response.statusCode).toBe(200);
}

function insertInbound(
  fixture: TestFixture,
  accountId: string,
  item: NormalizedInboundItem,
  discoveredAt: number,
  replyEligible: boolean,
  id = randomUUID(),
): { id: string; replyId: string | null } {
  const session = fixture.repository.getSession(accountId);
  if (!session) throw new Error("missing Partner account");
  const result = fixture.repository.insertInbound({
    id,
    sessionId: accountId,
    source: item.source,
    externalIdHash: fixture.secureStore.keyedHash(
      item.externalId,
      `inbound:${accountId}:${item.source}`,
    ),
    payloadEnvelope: fixture.secureStore.encryptJson(
      item,
      accountId,
      `inbound:${id}`,
    ),
    occurredAt: item.occurredAt,
    discoveredAt,
    historical: false,
    replyEligible,
    authGeneration: session.authGeneration,
    runGeneration: session.runGeneration,
    platformClientId: randomUUID(),
  });
  expect(result.inserted).toBe(true);
  return { id, replyId: result.replyId };
}

function requireCursor(page: ContentPage): string {
  if (!page.nextCursor) throw new Error("missing next cursor");
  return page.nextCursor;
}

function bodyLimitOversizedDataUrl(): string {
  return `data:image/png;base64,${"A".repeat(1_100_000)}`;
}

function expectNoSensitiveKeys(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of [
    "externalId",
    "authorId",
    "target",
    "finderUsername",
    "uin",
    "token",
    "requestContext",
    "providerRequestId",
    "model",
    "sessionId",
  ]) {
    expect(serialized).not.toContain(`"${key}"`);
  }
  expect(serialized).not.toContain(CONCRETE_MODEL);
}
