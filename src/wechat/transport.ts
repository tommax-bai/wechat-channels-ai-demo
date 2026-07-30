import { randomUUID } from "node:crypto";
import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import type { WechatRequestContext } from "../types.js";

export type WechatEndpoint =
  | "authLoginCode"
  | "authLoginStatus"
  | "authData"
  | "helperUploadParams"
  | "dmLoginCookie"
  | "dmHistory"
  | "dmNewMessages"
  | "dmSessionInfo"
  | "dmSendText"
  | "postList"
  | "commentList"
  | "commentCreate";

export interface RequestDescriptor {
  path: string;
  encoding: "form" | "json";
  profile: "legacy" | "micro" | "dual";
  refererPath?: "/" | "/micro/interaction/comment";
  evidence: "live_probe" | "official_bundle" | "community_candidate";
  irreversible: boolean;
  requiresBaseResp?: boolean;
}

export const REQUEST_DESCRIPTORS: Readonly<Record<WechatEndpoint, RequestDescriptor>> = {
  authLoginCode: {
    path: "/cgi-bin/mmfinderassistant-bin/auth/auth_login_code",
    encoding: "form",
    profile: "legacy",
    evidence: "live_probe",
    irreversible: false,
  },
  authLoginStatus: {
    path: "/cgi-bin/mmfinderassistant-bin/auth/auth_login_status",
    encoding: "form",
    profile: "legacy",
    evidence: "live_probe",
    irreversible: false,
  },
  authData: {
    path: "/cgi-bin/mmfinderassistant-bin/auth/auth_data",
    encoding: "form",
    profile: "dual",
    refererPath: "/",
    evidence: "community_candidate",
    irreversible: false,
  },
  helperUploadParams: {
    path: "/cgi-bin/mmfinderassistant-bin/helper/helper_upload_params",
    encoding: "form",
    profile: "legacy",
    evidence: "community_candidate",
    irreversible: false,
  },
  dmLoginCookie: {
    path: "/cgi-bin/mmfinderassistant-bin/private-msg/get-login-cookie",
    encoding: "form",
    profile: "legacy",
    evidence: "official_bundle",
    irreversible: false,
    requiresBaseResp: true,
  },
  dmHistory: {
    path: "/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg",
    encoding: "form",
    profile: "legacy",
    evidence: "official_bundle",
    irreversible: false,
  },
  dmNewMessages: {
    path: "/cgi-bin/mmfinderassistant-bin/private-msg/get-new-msg",
    encoding: "form",
    profile: "legacy",
    evidence: "official_bundle",
    irreversible: false,
    requiresBaseResp: true,
  },
  dmSessionInfo: {
    path: "/cgi-bin/mmfinderassistant-bin/private-msg/get-session-info",
    encoding: "json",
    profile: "legacy",
    evidence: "official_bundle",
    irreversible: false,
  },
  dmSendText: {
    path: "/cgi-bin/mmfinderassistant-bin/private-msg/send-private-msg",
    encoding: "json",
    profile: "legacy",
    evidence: "official_bundle",
    irreversible: true,
    requiresBaseResp: true,
  },
  postList: {
    path: "/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list",
    encoding: "json",
    profile: "micro",
    refererPath: "/",
    evidence: "live_probe",
    irreversible: false,
  },
  commentList: {
    path: "/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/comment_list",
    encoding: "json",
    profile: "micro",
    refererPath: "/",
    evidence: "live_probe",
    irreversible: false,
  },
  commentCreate: {
    path: "/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/create_comment",
    encoding: "json",
    profile: "micro",
    refererPath: "/micro/interaction/comment",
    evidence: "official_bundle",
    irreversible: true,
    requiresBaseResp: true,
  },
};

export class WechatApiError extends Error {
  constructor(
    readonly code: string,
    readonly endpoint: WechatEndpoint,
    readonly ambiguous: boolean,
    message = code,
  ) {
    super(message);
    this.name = "WechatApiError";
  }
}

export interface TransportOptions {
  baseUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export const DEFAULT_WECHAT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface RequestContext {
  jar: CookieJar;
  uin?: string;
  finderUsername?: string;
  userAgent?: string;
  requestContext?: WechatRequestContext;
}

export interface TransportResult {
  data: Record<string, unknown>;
  response: Response;
}

export class WechatTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(private readonly options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? DEFAULT_WECHAT_USER_AGENT;
  }

  createJar(serialized?: SerializedCookieJar): CookieJar {
    return serialized ? CookieJar.deserializeSync(serialized) : new CookieJar();
  }

  async request(
    endpoint: WechatEndpoint,
    businessBody: Record<string, unknown>,
    context: RequestContext,
    query: Record<string, string> = {},
    beforeDispatch?: () => boolean,
  ): Promise<TransportResult> {
    const descriptor = REQUEST_DESCRIPTORS[endpoint];
    const url = new URL(`${this.baseUrl}${descriptor.path}`);
    const useMicro = descriptor.profile === "micro"
      || (descriptor.profile === "dual" && context.requestContext !== undefined);
    const requestContext = useMicro
      ? requireMicroRequestContext(context, endpoint)
      : null;
    if (requestContext) {
      url.searchParams.set("_aid", requestContext.aid);
      url.searchParams.set("_pageUrl", requestContext.pageUrl);
      url.searchParams.set("_rid", randomUUID());
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const body = requestContext
      ? microBody(requestContext, businessBody)
      : commonBody(context.finderUsername ?? "", businessBody);
    const cookie = await context.jar.getCookieString(url.toString());
    if (beforeDispatch && !beforeDispatch()) {
      throw new WechatApiError("dispatch_not_authorized", endpoint, false);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": (useMicro || descriptor.encoding === "json")
            ? "application/json"
            : "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": context.userAgent ?? this.userAgent,
          "X-Wechat-Uin": requestContext?.headers.wechatUin
            ?? context.uin?.trim()
            ?? "0000000000",
          ...(requestContext ? {
            Referer: `${this.baseUrl}${descriptor.refererPath ?? "/"}`,
            "finger-print-device-id": requestContext.headers.fingerprintDeviceId,
          } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: useMicro || descriptor.encoding === "json"
          ? JSON.stringify(body)
          : encodeForm(body),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WechatApiError(
          `http_${response.status}`,
          endpoint,
          descriptor.irreversible && response.status >= 500,
        );
      }
      try {
        await absorbCookies(context.jar, response, url);
      } catch {
        throw new WechatApiError("response_cookie_error", endpoint, descriptor.irreversible);
      }
      const raw = await readBounded(response, this.options.maxResponseBytes, endpoint);
      let envelope: Record<string, unknown>;
      try {
        envelope = asRecord(JSON.parse(raw), endpoint, "response");
      } catch (error) {
        if (error instanceof WechatApiError) throw error;
        throw new WechatApiError("invalid_json", endpoint, descriptor.irreversible);
      }
      const outerCode = numberLike(envelope.errCode ?? envelope.errcode ?? envelope.code);
      if (outerCode === null) {
        throw new WechatApiError(
          "schema_changed:response.errCode",
          endpoint,
          descriptor.irreversible,
        );
      }
      if (outerCode !== 0) {
        throw new WechatApiError(
          isAuthCode(outerCode) ? "auth_required" : `platform_${outerCode ?? "unknown"}`,
          endpoint,
          false,
        );
      }
      const data = asRecord(envelope.data ?? {}, endpoint, "data");
      const baseRespValue = data.baseResp ?? data.base_resp;
      if (descriptor.requiresBaseResp && baseRespValue === undefined) {
        throw new WechatApiError(
          "schema_changed:data.baseResp",
          endpoint,
          descriptor.irreversible,
        );
      }
      if (baseRespValue !== undefined) {
        const baseResp = asRecord(baseRespValue, endpoint, "data.baseResp");
        const nestedCode = numberLike(baseResp.errcode ?? baseResp.errCode ?? baseResp.code);
        if (nestedCode === null) {
          throw new WechatApiError(
            "schema_changed:data.baseResp.errcode",
            endpoint,
            descriptor.irreversible,
          );
        }
        if (nestedCode !== 0) {
          throw new WechatApiError(
            isAuthCode(nestedCode) ? "auth_required" : `platform_${nestedCode ?? "unknown"}`,
            endpoint,
            false,
          );
        }
      }
      return { data, response };
    } catch (error) {
      if (error instanceof WechatApiError) throw error;
      const code = controller.signal.aborted
        || (error instanceof Error && error.name === "AbortError")
        ? "timeout"
        : response
          ? "response_read_error"
          : "network_error";
      throw new WechatApiError(code, endpoint, descriptor.irreversible, code);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireMicroRequestContext(
  context: RequestContext,
  endpoint: WechatEndpoint,
): WechatRequestContext {
  const value = context.requestContext;
  const missingCode = endpoint === "postList"
    || endpoint === "commentList"
    || endpoint === "commentCreate"
    ? "schema_changed:comment_context_missing"
    : "schema_changed:request_context_missing";
  if (
    !value
    || value.version !== 1
    || !bounded(value.aid, 1_024, true)
    || !bounded(value.pageUrl, 8 * 1_024, true)
    || !bounded(value.commonBody.logFinderId, 1_024, true)
    || !bounded(value.commonBody.logFinderUin, 1_024, false)
    || !bounded(value.commonBody.rawKeyBuff, 16 * 1_024, false)
    || (value.commonBody.pluginSessionId !== null
      && !bounded(value.commonBody.pluginSessionId, 4 * 1_024, false))
    || !Number.isSafeInteger(value.commonBody.reqScene)
    || !Number.isSafeInteger(value.commonBody.scene)
    || !bounded(value.headers.fingerprintDeviceId, 1_024, true)
    || !bounded(value.headers.wechatUin, 1_024, true)
  ) {
    throw new WechatApiError(missingCode, endpoint, false);
  }
  return value;
}

function microBody(
  context: WechatRequestContext,
  businessBody: Record<string, unknown>,
): Record<string, unknown> {
  return {
    _log_finder_id: context.commonBody.logFinderId,
    _log_finder_uin: context.commonBody.logFinderUin,
    rawKeyBuff: context.commonBody.rawKeyBuff,
    timestamp: String(Date.now()),
    scene: context.commonBody.scene,
    reqScene: context.commonBody.reqScene,
    pluginSessionId: context.commonBody.pluginSessionId,
    ...businessBody,
  };
}

function bounded(
  value: unknown,
  max: number,
  nonempty: boolean,
): value is string {
  return typeof value === "string"
    && value.length <= max
    && (!nonempty || value.length > 0);
}

function commonBody(finderUsername: string, businessBody: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: String(Date.now()),
    _log_finder_uin: "",
    _log_finder_id: finderUsername,
    rawKeyBuff: "",
    pluginSessionId: null,
    scene: 7,
    reqScene: 7,
    ...businessBody,
  };
}

function encodeForm(body: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (value === null) {
      form.set(key, "");
    } else if (typeof value === "object") {
      form.set(key, JSON.stringify(value));
    } else {
      form.set(key, String(value));
    }
  }
  return form;
}

async function absorbCookies(jar: CookieJar, response: Response, url: URL): Promise<void> {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : splitSetCookie(response.headers.get("set-cookie"));
  for (const value of values) {
    await jar.setCookie(value, url.toString(), { ignoreError: false });
  }
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=[^;,]+=)/g).map((part) => part.trim()).filter(Boolean);
}

async function readBounded(response: Response, maxBytes: number, endpoint: WechatEndpoint): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WechatApiError("response_too_large", endpoint, REQUEST_DESCRIPTORS[endpoint].irreversible);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WechatApiError("response_too_large", endpoint, REQUEST_DESCRIPTORS[endpoint].irreversible);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function asRecord(value: unknown, endpoint: WechatEndpoint, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WechatApiError(`schema_changed:${field}`, endpoint, REQUEST_DESCRIPTORS[endpoint].irreversible);
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  record: Record<string, unknown>,
  keys: readonly string[],
  endpoint: WechatEndpoint,
  field: string,
): string {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim();
    }
  }
  throw new WechatApiError(`schema_changed:${field}`, endpoint, REQUEST_DESCRIPTORS[endpoint].irreversible);
}

export function optionalString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

export function numberLike(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

export function epochMs(value: unknown, fallback = Date.now()): number {
  const number = numberLike(value);
  if (number === null || number < 0) return fallback;
  return Math.floor(number < 10_000_000_000 ? number * 1_000 : number);
}

export function newClientId(): string {
  return randomUUID();
}

function isAuthCode(code: number | null): boolean {
  return code === -20001
    || code === 20001
    || code === 300333
    || code === 300334;
}
