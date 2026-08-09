import { describe, expect, it } from "vitest";
import { loadConfig, safeStartupSummary } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  DATABASE_PATH: ":memory:",
};

describe("session cookie security", () => {
  it("defaults secure in production and allows an explicit loopback override", () => {
    expect(loadConfig({ ...baseEnv, NODE_ENV: "production" }).sessionCookieSecure)
      .toBe(true);
    expect(loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      SESSION_COOKIE_SECURE: "0",
    }).sessionCookieSecure).toBe(false);
    expect(loadConfig({ ...baseEnv, NODE_ENV: "development" }).sessionCookieSecure)
      .toBe(false);
  });

  it("rejects an insecure production cookie on a public listener", () => {
    expect(() => loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      SESSION_COOKIE_SECURE: "0",
    })).toThrow("allowed in production only on a loopback HOST");
  });

  it("separates browser cookie duration from unauthenticated cleanup", () => {
    const config = loadConfig({
      ...baseEnv,
      SESSION_COOKIE_MAX_AGE_SECONDS: "31536000",
      PENDING_SESSION_TTL_MS: "86400000",
    });

    expect(config.sessionCookieMaxAgeSeconds).toBe(31_536_000);
    expect(config.pendingSessionTtlMs).toBe(86_400_000);
  });

  it("accepts the former session TTL only as a transient cleanup fallback", () => {
    const config = loadConfig({
      ...baseEnv,
      SESSION_TTL_MS: "28800000",
    });

    expect(config.pendingSessionTtlMs).toBe(28_800_000);
    expect(config.sessionCookieMaxAgeSeconds).toBe(31_536_000);
  });
});

describe("reply provider configuration", () => {
  it("keeps the funnel provider optional with a bounded timeout default", () => {
    const config = loadConfig(baseEnv);

    expect(config.funnelBaseUrl).toBeUndefined();
    expect(config.funnelTimeoutMs).toBe(45_000);
  });

  it("normalizes the server-only funnel URL without exposing it in startup logs", () => {
    const config = loadConfig({
      ...baseEnv,
      FUNNEL_BASE_URL: "http://115.190.239.42:9093///",
      FUNNEL_TIMEOUT_MS: "7000",
    });
    const summary = safeStartupSummary(config);

    expect(config.funnelBaseUrl).toBe("http://115.190.239.42:9093");
    expect(config.funnelTimeoutMs).toBe(7_000);
    expect(summary).toMatchObject({ funnelReplyConfigured: true });
    expect(JSON.stringify(summary)).not.toContain("115.190.239.42");
    expect(summary).not.toHaveProperty("model");
  });
});

describe("Partner API configuration", () => {
  it("keeps the Partner API disabled when its server credential is absent", () => {
    const config = loadConfig(baseEnv);

    expect(config.partnerApiKey).toBeUndefined();
    expect(safeStartupSummary(config)).toMatchObject({
      partnerApiConfigured: false,
    });
  });

  it("validates the credential without exposing it in startup output", () => {
    const fixtureKey = "p".repeat(32);
    const config = loadConfig({
      ...baseEnv,
      PARTNER_API_KEY: fixtureKey,
    });
    const summary = safeStartupSummary(config);

    expect(config.partnerApiKey).toBe(fixtureKey);
    expect(summary).toMatchObject({ partnerApiConfigured: true });
    expect(JSON.stringify(summary)).not.toContain(fixtureKey);
    expect(() => loadConfig({
      ...baseEnv,
      PARTNER_API_KEY: "too-short",
    })).toThrow();
  });
});
