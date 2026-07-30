import {
  chromium,
  type Browser,
  type Cookie as PlaywrightCookie,
  type Page,
  type Request,
} from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieJar } from "tough-cookie";
import {
  cookiesForBrowser,
  parseCapturedAuthRequest,
  PlaywrightWechatSessionCapturer,
  rebuildCookieJarFromBrowserSnapshot,
  waitForAuthDataRequest,
  type CapturedAuthRequest,
} from "../src/wechat/browser-capture.js";
import { fakePlatformSession } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("first-party WeChat request context capture", () => {
  it("accepts only the bounded auth_data request for the expected Finder identity", () => {
    expect(parseCapturedAuthRequest(validCapture(), "finder-self")).toEqual({
      version: 1,
      aid: "aid-test",
      pageUrl: "https://channels.weixin.qq.com/platform/post/list",
      commonBody: {
        logFinderId: "finder-self",
        logFinderUin: null,
        rawKeyBuff: "",
        pluginSessionId: null,
        reqScene: 7,
        scene: 7,
      },
      headers: {
        fingerprintDeviceId: "fingerprint-test",
        wechatUin: "10001",
      },
    });
  });

  it.each([
    "http://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data?_aid=a&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Fplatform%2Fpost%2Flist",
    "https://channels.weixin.qq.com.evil.test/cgi-bin/mmfinderassistant-bin/auth/auth_data?_aid=a&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Fplatform%2Fpost%2Flist",
    "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/post/post_list?_aid=a&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Fplatform%2Fpost%2Flist",
  ])("ignores a non-target request: %s", (url) => {
    expect(parseCapturedAuthRequest({ ...validCapture(), url }, "finder-self"))
      .toBeNull();
  });

  it("fails closed on a missing required header", () => {
    const captured = validCapture();
    delete captured.headers["finger-print-device-id"];
    expect(() => parseCapturedAuthRequest(captured, "finder-self"))
      .toThrowError(expect.objectContaining({
        code: "schema_changed:browser_auth_context",
        endpoint: "authData",
      }));
  });

  it("fails closed when the captured identity differs from the confirmed login", () => {
    expect(() => parseCapturedAuthRequest(validCapture(), "another-finder"))
      .toThrowError(expect.objectContaining({
        code: "browser_capture_identity_mismatch",
        endpoint: "authData",
      }));
  });

  it("rejects oversized captured values", () => {
    const captured = validCapture();
    captured.headers["finger-print-device-id"] = "x".repeat(16 * 1_024 + 1);
    expect(() => parseCapturedAuthRequest(captured, "finder-self"))
      .toThrowError(expect.objectContaining({
        code: "schema_changed:browser_auth_context",
      }));
  });

  it("preserves domain-cookie scope when importing the encrypted jar", async () => {
    const jar = new CookieJar();
    await jar.setCookie(
      "domain_cookie=1; Domain=.weixin.qq.com; Path=/; Secure",
      "https://channels.weixin.qq.com/",
    );
    await jar.setCookie(
      "host_cookie=1; Path=/; Secure",
      "https://channels.weixin.qq.com/",
    );
    const serialized = jar.serializeSync();
    if (!serialized) throw new Error("missing serialized jar");

    const cookies = await cookiesForBrowser(
      serialized,
      "https://channels.weixin.qq.com",
    );

    expect(cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "domain_cookie",
        domain: ".weixin.qq.com",
      }),
      expect.objectContaining({
        name: "host_cookie",
        domain: "channels.weixin.qq.com",
      }),
    ]));
  });

  it("clamps long-lived cookies to the browser-supported expiry limit", async () => {
    const jar = new CookieJar();
    await jar.setCookie(
      "long_lived=1; Path=/; Secure; Max-Age=253402300799",
      "https://channels.weixin.qq.com/",
    );
    const serialized = jar.serializeSync();
    if (!serialized) throw new Error("missing serialized jar");

    const cookies = await cookiesForBrowser(
      serialized,
      "https://channels.weixin.qq.com",
    );

    expect(cookies).toEqual([
      expect.objectContaining({
        name: "long_lived",
        expires: 253_402_300_799,
      }),
    ]);
  });

  it("rebuilds the encrypted jar from the authoritative browser snapshot", async () => {
    const serialized = await rebuildCookieJarFromBrowserSnapshot([
      browserCookie({
        name: "current_cookie",
        value: "fresh",
        domain: "channels.weixin.qq.com",
      }),
      browserCookie({
        name: "domain_cookie",
        value: "shared",
        domain: ".weixin.qq.com",
      }),
      browserCookie({
        name: "ignored_cookie",
        value: "other",
        domain: "example.com",
      }),
    ], "https://channels.weixin.qq.com");
    const rebuilt = CookieJar.deserializeSync(serialized);

    expect(await rebuilt.getCookieString("https://channels.weixin.qq.com/"))
      .toContain("current_cookie=fresh");
    expect(await rebuilt.getCookieString("https://channels.weixin.qq.com/"))
      .toContain("domain_cookie=shared");
    expect((await rebuilt.getCookies(
      "https://channels.weixin.qq.com/",
      { allPaths: true },
    )).map((cookie) => cookie.key).sort())
      .toEqual(["current_cookie", "domain_cookie"]);
  });

  it("waits past invalid auth_data candidates and removes the listener after the first valid request", async () => {
    const page = new FakeRequestPage();
    const pending = waitForAuthDataRequest(
      page as unknown as Page,
      "https://channels.weixin.qq.com/platform/post/list",
      "finder-self",
      250,
    );
    const invalid = validCapture();
    delete invalid.headers["finger-print-device-id"];
    page.emitRequest(requestFromCapture(invalid));
    page.emitRequest(requestFromCapture(validCapture()));

    await expect(pending).resolves.toEqual(validCapture());
    expect(page.listenerCount()).toBe(0);
  });

  it("bounds browser cleanup and prioritizes its failure over the capture error", async () => {
    const browser = {
      newContext: async () => {
        throw new Error("primary capture failure");
      },
      close: () => new Promise<void>(() => undefined),
    } as unknown as Browser;
    vi.spyOn(chromium, "launch").mockResolvedValue(browser);
    const capturer = new PlaywrightWechatSessionCapturer({
      baseUrl: "https://channels.weixin.qq.com",
      executablePath: "/unused/chrome",
      timeoutMs: 15,
      headless: true,
    });
    const startedAt = Date.now();

    await expect(capturer.capture(fakePlatformSession())).rejects.toMatchObject({
      code: "browser_capture_cleanup_failed",
      endpoint: "authData",
      ambiguous: false,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("projects a safe stage-specific error when browser context creation fails", async () => {
    const browser = {
      newContext: async () => {
        throw new Error("raw browser context error");
      },
      close: async () => undefined,
    } as unknown as Browser;
    vi.spyOn(chromium, "launch").mockResolvedValue(browser);
    const capturer = new PlaywrightWechatSessionCapturer({
      baseUrl: "https://channels.weixin.qq.com",
      executablePath: "/unused/chrome",
      timeoutMs: 100,
      headless: true,
    });

    await expect(capturer.capture(fakePlatformSession())).rejects.toMatchObject({
      code: "browser_capture_context_failed",
      endpoint: "authData",
      ambiguous: false,
    });
  });
});

function validCapture(): CapturedAuthRequest {
  return {
    url: "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data"
      + "?_aid=aid-test"
      + "&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Fplatform%2Fpost%2Flist",
    postData: JSON.stringify({
      _log_finder_id: "finder-self",
      _log_finder_uin: null,
      rawKeyBuff: "",
      pluginSessionId: null,
      reqScene: 7,
      scene: 7,
    }),
    headers: {
      "finger-print-device-id": "fingerprint-test",
      "X-WECHAT-UIN": "10001",
    },
  };
}

function browserCookie(
  overrides: Partial<PlaywrightCookie>,
): PlaywrightCookie {
  return {
    name: "cookie",
    value: "value",
    domain: "channels.weixin.qq.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...overrides,
  };
}

function requestFromCapture(captured: CapturedAuthRequest): Request {
  return {
    url: () => captured.url,
    postData: () => captured.postData,
    allHeaders: async () => captured.headers,
  } as unknown as Request;
}

type RequestListener = (request: Request) => void;

class FakeRequestPage {
  private readonly requestListeners = new Set<RequestListener>();

  on(_event: "request", listener: RequestListener): this {
    this.requestListeners.add(listener);
    return this;
  }

  off(_event: "request", listener: RequestListener): this {
    this.requestListeners.delete(listener);
    return this;
  }

  goto(): Promise<null> {
    return Promise.resolve(null);
  }

  reload(): Promise<null> {
    return Promise.resolve(null);
  }

  emitRequest(request: Request): void {
    for (const listener of this.requestListeners) listener(request);
  }

  listenerCount(): number {
    return this.requestListeners.size;
  }
}
