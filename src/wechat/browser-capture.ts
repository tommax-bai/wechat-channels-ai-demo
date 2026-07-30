import {
  chromium,
  type Browser,
  type BrowserContext,
  type Cookie as PlaywrightCookie,
  type Page,
  type Request,
} from "playwright-core";
import { CookieJar } from "tough-cookie";
import type {
  PlatformSession,
  WechatRequestContext,
} from "../types.js";
import { WechatApiError } from "./transport.js";

const MAX_USER_AGENT_BYTES = 1_024;
const MAX_AID_BYTES = 1_024;
const MAX_PAGE_URL_BYTES = 8 * 1_024;
const MAX_COMMON_VALUE_BYTES = 16 * 1_024;
const MAX_POST_DATA_BYTES = 32 * 1_024;
const MAX_REQUEST_URL_BYTES = 8 * 1_024;
const MAX_BROWSER_CLEANUP_MS = 5_000;
const MAX_COOKIE_EXPIRES_SECONDS = 253_402_300_799;
const CREATOR_POST_PATH = "/platform/post/list";
const AUTH_DATA_SUFFIX = "/auth/auth_data";
type BrowserCookieParam = Parameters<BrowserContext["addCookies"]>[0][number];
type BrowserCaptureStage =
  | "launch"
  | "new_context"
  | "import_cookies"
  | "new_page"
  | "capture_request"
  | "snapshot_cookies"
  | "rebuild_cookie_jar";

export interface WechatSessionCapturer {
  capture(session: PlatformSession): Promise<PlatformSession>;
}

export interface BrowserCaptureOptions {
  baseUrl: string;
  executablePath: string;
  timeoutMs: number;
  headless: boolean;
}

export interface CapturedAuthRequest {
  url: string;
  postData: string | null;
  headers: Record<string, string>;
}

export class PlaywrightWechatSessionCapturer implements WechatSessionCapturer {
  private captureTail: Promise<void> = Promise.resolve();
  private readonly baseUrl: string;

  constructor(private readonly options: BrowserCaptureOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "channels.weixin.qq.com") {
      throw new Error("browser capture requires the exact WeChat Channels HTTPS origin");
    }
    this.baseUrl = parsed.origin;
  }

  capture(session: PlatformSession): Promise<PlatformSession> {
    const work = this.captureTail.then(() => this.captureOnce(session));
    this.captureTail = work.then(() => undefined, () => undefined);
    return work;
  }

  private async captureOnce(session: PlatformSession): Promise<PlatformSession> {
    let browser: Browser | undefined;
    let result: PlatformSession | undefined;
    let failure: unknown;
    let stage: BrowserCaptureStage = "launch";
    try {
      try {
        browser = await chromium.launch({
          executablePath: this.options.executablePath,
          headless: this.options.headless,
          timeout: this.options.timeoutMs,
          args: [
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--no-sandbox",
          ],
        });
      } catch {
        throw new WechatApiError(
          "browser_capture_unavailable",
          "authData",
          false,
        );
      }
      stage = "new_context";
      const context = await browser.newContext({
        userAgent: session.userAgent,
        locale: "zh-CN",
        viewport: { width: 1365, height: 900 },
      });
      stage = "import_cookies";
      await context.addCookies(await cookiesForBrowser(session.cookieJar, this.baseUrl));
      stage = "new_page";
      const page = await context.newPage();
      stage = "capture_request";
      const captured = await waitForAuthDataRequest(
        page,
        `${this.baseUrl}${CREATOR_POST_PATH}`,
        session.finderUsername,
        this.options.timeoutMs,
      );
      const requestContext = parseCapturedAuthRequest(
        captured,
        session.finderUsername,
      );
      if (!requestContext) {
        throw new WechatApiError(
          "schema_changed:browser_auth_context",
          "authData",
          false,
        );
      }
      const userAgent = session.userAgent;
      if (
        typeof userAgent !== "string"
        || userAgent.length === 0
        || userAgent.length > MAX_USER_AGENT_BYTES
      ) {
        throw new WechatApiError(
          "schema_changed:browser_user_agent",
          "authData",
          false,
        );
      }
      stage = "snapshot_cookies";
      const browserCookies = await context.cookies();
      stage = "rebuild_cookie_jar";
      const cookieJar = await rebuildCookieJarFromBrowserSnapshot(
        browserCookies,
        this.baseUrl,
      );
      result = {
        ...session,
        transportProfile: "micro_v1",
        cookieJar,
        userAgent,
        requestContext,
        acquiredAt: Date.now(),
      };
    } catch (error) {
      failure = normalizeBrowserCaptureFailure(error, stage);
    }
    if (browser) {
      try {
        await closeBrowserWithin(
          browser,
          Math.min(MAX_BROWSER_CLEANUP_MS, Math.max(1, this.options.timeoutMs)),
        );
      } catch {
        failure = new WechatApiError(
          "browser_capture_cleanup_failed",
          "authData",
          false,
        );
      }
    }
    if (failure) {
      if (failure instanceof WechatApiError) throw failure;
      throw new WechatApiError("browser_capture_failed", "authData", false);
    }
    if (!result) {
      throw new WechatApiError("browser_capture_failed", "authData", false);
    }
    return result;
  }
}

function normalizeBrowserCaptureFailure(
  error: unknown,
  stage: BrowserCaptureStage,
): WechatApiError {
  if (error instanceof WechatApiError) return error;
  const codeByStage: Record<BrowserCaptureStage, string> = {
    launch: "browser_capture_unavailable",
    new_context: "browser_capture_context_failed",
    import_cookies: "browser_capture_cookie_import_failed",
    new_page: "browser_capture_page_failed",
    capture_request: "browser_capture_request_failed",
    snapshot_cookies: "browser_capture_cookie_snapshot_failed",
    rebuild_cookie_jar: "browser_capture_cookie_rebuild_failed",
  };
  return new WechatApiError(codeByStage[stage], "authData", false);
}

export function parseCapturedAuthRequest(
  captured: CapturedAuthRequest,
  expectedFinderUsername: string,
): WechatRequestContext | null {
  if (
    captured.url.length === 0
    || captured.url.length > MAX_REQUEST_URL_BYTES
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(captured.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "channels.weixin.qq.com"
    || !url.pathname.endsWith(AUTH_DATA_SUFFIX)
  ) {
    return null;
  }
  try {
    const aid = boundedNonempty(url.searchParams.get("_aid"), MAX_AID_BYTES);
    const pageUrl = boundedNonempty(
      url.searchParams.get("_pageUrl"),
      MAX_PAGE_URL_BYTES,
    );
    const parsedPageUrl = new URL(pageUrl);
    if (
      parsedPageUrl.protocol !== "https:"
      || parsedPageUrl.hostname !== "channels.weixin.qq.com"
    ) {
      throw new Error("invalid page URL");
    }
    if (
      captured.postData === null
      || captured.postData.length === 0
      || captured.postData.length > MAX_POST_DATA_BYTES
    ) {
      throw new Error("invalid post data");
    }
    const body = JSON.parse(captured.postData) as unknown;
    if (!isRecord(body)) throw new Error("invalid request body");
    const logFinderId = boundedNonempty(
      body._log_finder_id,
      MAX_COMMON_VALUE_BYTES,
    );
    if (logFinderId !== expectedFinderUsername) {
      throw new WechatApiError(
        "browser_capture_identity_mismatch",
        "authData",
        false,
      );
    }
    const logFinderUin = boundedString(
      body._log_finder_uin,
      MAX_COMMON_VALUE_BYTES,
    );
    const rawKeyBuff = boundedString(body.rawKeyBuff, MAX_COMMON_VALUE_BYTES);
    const pluginSessionId = nullableBoundedString(
      body.pluginSessionId,
      MAX_COMMON_VALUE_BYTES,
    );
    const reqScene = safeInteger(body.reqScene);
    const scene = safeInteger(body.scene);
    const headers = lowerCaseHeaders(captured.headers);
    const fingerprintDeviceId = boundedNonempty(
      headers["finger-print-device-id"],
      MAX_COMMON_VALUE_BYTES,
    );
    const wechatUin = boundedNonempty(
      headers["x-wechat-uin"],
      MAX_COMMON_VALUE_BYTES,
    );
    return {
      version: 1,
      aid,
      pageUrl,
      commonBody: {
        logFinderId,
        logFinderUin,
        rawKeyBuff,
        pluginSessionId,
        reqScene,
        scene,
      },
      headers: {
        fingerprintDeviceId,
        wechatUin,
      },
    };
  } catch (error) {
    if (error instanceof WechatApiError) throw error;
    throw new WechatApiError(
      "schema_changed:browser_auth_context",
      "authData",
      false,
    );
  }
}

export async function waitForAuthDataRequest(
  page: Page,
  startUrl: string,
  expectedFinderUsername: string,
  timeoutMs: number,
): Promise<CapturedAuthRequest> {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let requestHandler: ((request: Request) => void) | undefined;
  const captured = new Promise<CapturedAuthRequest>((resolve, reject) => {
    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (requestHandler) page.off("request", requestHandler);
      callback();
    };
    requestHandler = (request): void => {
      const rawUrl = request.url();
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return;
      }
      if (
        url.protocol !== "https:"
        || url.hostname !== "channels.weixin.qq.com"
        || !url.pathname.endsWith(AUTH_DATA_SUFFIX)
      ) {
        return;
      }
      void request.allHeaders()
        .then((headers) => {
          if (settled) return;
          const candidate = {
            url: rawUrl,
            postData: request.postData(),
            headers,
          };
          const requestContext = parseCapturedAuthRequest(
            candidate,
            expectedFinderUsername,
          );
          if (!requestContext) return;
          finish(() => resolve(candidate));
        })
        .catch(() => undefined);
    };
    page.on("request", requestHandler);
    timer = setTimeout(() => {
      finish(() => reject(new WechatApiError(
        "browser_capture_timeout",
        "authData",
        false,
      )));
    }, timeoutMs);
  });
  void page.goto(startUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  }).then(async () => {
    if (!settled) {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      }).catch(() => undefined);
    }
  }).catch(() => undefined);
  return captured;
}

export async function cookiesForBrowser(
  serialized: PlatformSession["cookieJar"],
  baseUrl: string,
): Promise<BrowserCookieParam[]> {
  const jar = CookieJar.deserializeSync(serialized);
  const cookies = await jar.getCookies(baseUrl, { allPaths: true });
  const mapped = cookies
    .filter((cookie) => isWechatCookieDomain(cookie.domain ?? ""))
    .map((cookie): BrowserCookieParam => {
      const expiryMs = cookie.expiryTime();
      return {
        name: cookie.key,
        value: cookie.value,
        domain: cookie.hostOnly
          ? cookie.domain ?? new URL(baseUrl).hostname
          : `.${(cookie.domain ?? new URL(baseUrl).hostname).replace(/^\./, "")}`,
        path: cookie.path || "/",
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        ...(cookie.sameSite
          ? { sameSite: playwrightSameSite(cookie.sameSite) }
          : {}),
        expires: browserCookieExpires(expiryMs),
      };
    });
  if (mapped.length === 0) {
    throw new WechatApiError(
      "browser_capture_cookie_missing",
      "authData",
      false,
    );
  }
  return mapped;
}

export async function rebuildCookieJarFromBrowserSnapshot(
  browserCookies: PlaywrightCookie[],
  baseUrl: string,
): Promise<PlatformSession["cookieJar"]> {
  const jar = new CookieJar();
  let imported = 0;
  for (const cookie of browserCookies) {
    if (!isWechatCookieDomain(cookie.domain)) continue;
    const normalizedDomain = cookie.domain.replace(/^\./, "");
    const attributes = [
      `${cookie.name}=${cookie.value}`,
      `Path=${cookie.path || "/"}`,
      ...(cookie.domain.startsWith(".") ? [`Domain=${cookie.domain}`] : []),
      ...(cookie.httpOnly ? ["HttpOnly"] : []),
      ...(cookie.secure ? ["Secure"] : []),
      ...(cookie.sameSite ? [`SameSite=${cookie.sameSite}`] : []),
      ...(cookie.expires > 0
        ? [`Expires=${new Date(cookie.expires * 1_000).toUTCString()}`]
        : []),
    ];
    await jar.setCookie(
      attributes.join("; "),
      `${new URL(baseUrl).protocol}//${normalizedDomain}${cookie.path || "/"}`,
    );
    imported += 1;
  }
  if (imported === 0) {
    throw new WechatApiError(
      "browser_capture_cookie_missing",
      "authData",
      false,
    );
  }
  const updated = jar.serializeSync();
  if (!updated) {
    throw new WechatApiError(
      "browser_capture_cookie_error",
      "authData",
      false,
    );
  }
  return updated;
}

export async function closeBrowserWithin(
  browser: Pick<Browser, "close">,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("browser cleanup timed out")),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => browser.close({
        reason: "one-time WeChat context capture complete",
      })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function playwrightSameSite(
  value: string | undefined,
): "Strict" | "Lax" | "None" {
  if (value === "strict") return "Strict";
  if (value === "none") return "None";
  return "Lax";
}

function browserCookieExpires(expiryMs: number | undefined): number {
  if (typeof expiryMs !== "number" || !Number.isFinite(expiryMs)) return -1;
  const expirySeconds = Math.floor(expiryMs / 1_000);
  if (expirySeconds <= 0) return -1;
  return Math.min(expirySeconds, MAX_COOKIE_EXPIRES_SECONDS);
}

function isWechatCookieDomain(raw: string): boolean {
  const domain = raw.replace(/^\./, "").toLowerCase();
  return domain === "weixin.qq.com" || domain.endsWith(".weixin.qq.com");
}

function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function boundedNonempty(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error("invalid bounded string");
  }
  return value;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error("invalid bounded string");
  }
  return value;
}

function nullableBoundedString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, max);
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("invalid integer");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
