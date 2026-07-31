import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
