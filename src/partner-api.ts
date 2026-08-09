import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { DemoRepository, SessionRow } from "./repository.js";
import type { SessionService } from "./service/session-service.js";
import type {
  AccountWechatQrMetadata,
  AuthState,
  InboundSource,
  PartnerContentCursor,
  PartnerContentItem,
  ReplyState,
  SessionSnapshot,
  SourceState,
} from "./types.js";

interface PartnerApiDependencies {
  config: AppConfig;
  repository: DemoRepository;
  sessions: SessionService;
}

type PublicLoginState =
  | "not_requested"
  | "waiting_scan"
  | "scanned"
  | "initializing"
  | "succeeded"
  | "qr_expired"
  | "cancelled"
  | "no_account"
  | "login_required"
  | "failed";

type PublicHostingState =
  | "not_ready"
  | "initializing"
  | "active"
  | "paused"
  | "degraded"
  | "expired";

type CredentialKind = "pending" | "capturing" | "session" | null;

interface ContentCursor {
  version: 1;
  accountId: string;
  source: InboundSource;
  discoveredAt: number;
  id: string;
}

const accountParams = z.object({
  accountId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const automationBody = z.object({ enabled: z.boolean() }).strict();
const replySettingsBody = z.object({
  provider: z.enum(["chat-llm", "funnel"]),
  jobNumber: z.string().max(128).optional(),
}).strict();
const accountWechatQrBody = z.object({
  dataUrl: z.string().min(1),
}).strict();
const contentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2_048).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1),
  accountId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  source: z.enum(["dm", "comment"]),
  discoveredAt: z.number().int().nonnegative(),
  id: z.string().uuid(),
}).strict();

export function registerPartnerApi(
  app: FastifyInstance,
  deps: PartnerApiDependencies,
): void {
  void app.register(async (partner) => {
    partner.addHook("onRequest", async (request, reply) => {
      authenticatePartner(request, reply, deps.config);
    });

    partner.get("/capabilities", async () => ({
      apiVersion: "v1",
      providers: [
        {
          id: "chat-llm",
          displayName: "CHAT回复",
          configured: Boolean(deps.config.arkApiKey),
          requiresJobNumber: false,
        },
        {
          id: "funnel",
          displayName: "招聘接口",
          configured: Boolean(deps.config.funnelBaseUrl),
          requiresJobNumber: true,
        },
      ],
      jobSelection: {
        mode: "known_job_number",
        catalogueAvailable: false,
      },
    }));

    partner.post("/accounts", async (_request, reply) => {
      const account = deps.sessions.createPartnerSession();
      return reply.code(201).send(await projectAccount(deps, account));
    });

    partner.get("/accounts", async () => ({
      items: await Promise.all(
        deps.sessions.listPartnerSessions().map((account) => projectAccount(deps, account)),
      ),
    }));

    partner.get("/accounts/:accountId", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      return projectAccount(deps, account);
    });

    partner.post("/accounts/:accountId/login/qr", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      await deps.sessions.startPartnerLogin(account);
      return projectAccount(
        deps,
        deps.repository.getSession(account.id) ?? account,
      );
    });

    partner.get("/accounts/:accountId/login/status", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      const projection = await projectAccount(deps, account);
      return {
        accountId: projection.accountId,
        accountDisplayName: projection.accountDisplayName,
        login: projection.login,
      };
    });

    partner.get("/accounts/:accountId/hosting", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      const projection = await projectAccount(deps, account);
      return {
        accountId: projection.accountId,
        hosting: projection.hosting,
        sources: projection.sources,
      };
    });

    partner.put("/accounts/:accountId/hosting", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      const body = automationBody.parse(request.body);
      const updated = deps.sessions.setAutomation(account, body.enabled);
      return projectAccount(deps, updated);
    });

    partner.put("/accounts/:accountId/reply-settings", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      const body = replySettingsBody.parse(request.body);
      const updated = deps.sessions.setReplyProvider(
        account,
        body.provider,
        body.jobNumber,
      );
      return projectAccount(deps, updated);
    });

    partner.get("/accounts/:accountId/wechat-qr", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      return {
        accountId: account.id,
        wechatQr: projectAccountWechatQr(
          deps.sessions.getAccountWechatQrMetadata(account.id),
        ),
      };
    });

    partner.put("/accounts/:accountId/wechat-qr", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      const body = accountWechatQrBody.parse(request.body);
      return {
        accountId: account.id,
        wechatQr: projectAccountWechatQr(
          deps.sessions.setAccountWechatQr(account, body.dataUrl),
        ),
      };
    });

    partner.delete("/accounts/:accountId/wechat-qr", async (request) => {
      const account = requirePartnerAccount(request, deps.sessions);
      return {
        accountId: account.id,
        wechatQr: projectAccountWechatQr(
          deps.sessions.deleteAccountWechatQr(account),
        ),
      };
    });

    partner.get("/accounts/:accountId/comments", async (request) => {
      return contentPage(request, deps, "comment");
    });

    partner.get("/accounts/:accountId/direct-messages", async (request) => {
      return contentPage(request, deps, "dm");
    });

    partner.delete("/accounts/:accountId", async (request, reply) => {
      const account = requirePartnerAccount(request, deps.sessions);
      deps.sessions.logout(account);
      return reply.code(204).send();
    });
  }, { prefix: "/partner/v1" });
}

function authenticatePartner(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): void {
  if (!config.partnerApiKey) throw new Error("partner_api_unavailable");
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string"
    ? /^Bearer ([^\s]+)$/.exec(authorization)
    : null;
  if (!match?.[1] || !secretsMatch(match[1], config.partnerApiKey)) {
    reply.header("WWW-Authenticate", "Bearer");
    throw new Error("partner_api_unauthorized");
  }
}

function secretsMatch(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function requirePartnerAccount(
  request: FastifyRequest,
  sessions: SessionService,
): SessionRow {
  const { accountId } = accountParams.parse(request.params);
  const account = sessions.resolveShared(accountId);
  if (!account) throw new Error("partner_account_not_found");
  return account;
}

async function projectAccount(
  deps: PartnerApiDependencies,
  account: SessionRow,
): Promise<{
  accountId: string;
  accountDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  login: {
    state: PublicLoginState;
    scanned: boolean;
    succeeded: boolean;
    qrDataUrl: string | null;
    qrExpiresAt: string | null;
    errorCode: string | null;
  };
  hosting: {
    state: PublicHostingState;
    automationEnabled: boolean;
    automationEffective: boolean;
    loginExpired: boolean;
    reloginRequired: boolean;
    credentialExpiresAt: null;
  };
  replySettings: {
    provider: "chat-llm" | "funnel";
    providerConfigured: boolean;
    jobNumber: string | null;
  };
  wechatQr: PublicAccountWechatQr;
  sources: {
    comments: PublicSource;
    directMessages: PublicSource;
  };
}> {
  const current = deps.repository.getSession(account.id) ?? account;
  const snapshot = await deps.sessions.snapshot(current);
  const credentialKind = deps.sessions.readCredential(current.id)?.kind ?? null;
  const login = projectLogin(snapshot, credentialKind);
  const sourceMap = new Map(snapshot.sources.map((source) => [source.source, source]));
  const comments = sourceMap.get("comment");
  const directMessages = sourceMap.get("dm");
  return {
    accountId: current.id,
    accountDisplayName: snapshot.accountDisplayName,
    createdAt: isoTimestamp(current.createdAt),
    updatedAt: isoTimestamp(current.updatedAt),
    login,
    hosting: projectHosting(snapshot, credentialKind),
    replySettings: {
      provider: snapshot.replyProvider,
      providerConfigured: snapshot.service.selectedProviderConfigured,
      jobNumber: snapshot.replyProvider === "funnel"
        ? snapshot.funnelJobNumber
        : null,
    },
    wechatQr: projectAccountWechatQr(snapshot.wechatQr),
    sources: {
      comments: projectSource(comments),
      directMessages: projectSource(directMessages),
    },
  };
}

interface PublicAccountWechatQr {
  configured: boolean;
  mimeType: "image/png" | "image/jpeg" | null;
  byteLength: number | null;
  updatedAt: string | null;
}

function projectAccountWechatQr(
  metadata: AccountWechatQrMetadata,
): PublicAccountWechatQr {
  return {
    configured: metadata.configured,
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
    updatedAt: nullableIsoTimestamp(metadata.updatedAt),
  };
}

interface PublicSource {
  state: SourceState;
  baselineComplete: boolean;
  lastSuccessAt: string | null;
  errorCode: string | null;
}

function projectLogin(snapshot: SessionSnapshot, credentialKind: CredentialKind): {
  state: PublicLoginState;
  scanned: boolean;
  succeeded: boolean;
  qrDataUrl: string | null;
  qrExpiresAt: string | null;
  errorCode: string | null;
} {
  const state = loginState(snapshot, credentialKind);
  return {
    state,
    scanned: [
      "scanned",
      "capturing_context",
      "authenticated",
      "baseline_sync",
      "active",
      "stopped",
    ].includes(snapshot.authState)
      || (
        snapshot.authState === "schema_changed"
        && credentialKind === "session"
      ),
    succeeded: [
      "authenticated",
      "baseline_sync",
      "active",
      "stopped",
    ].includes(snapshot.authState)
      || (snapshot.authState === "schema_changed" && credentialKind === "session"),
    qrDataUrl: state === "waiting_scan" ? snapshot.qrDataUrl : null,
    qrExpiresAt: state === "waiting_scan" && snapshot.qrExpiresAt !== null
      ? isoTimestamp(snapshot.qrExpiresAt)
      : null,
    errorCode: snapshot.authErrorCode,
  };
}

function loginState(
  snapshot: SessionSnapshot,
  credentialKind: CredentialKind,
): PublicLoginState {
  if (
    snapshot.authState === "qr_pending"
    && snapshot.qrExpiresAt !== null
    && snapshot.qrExpiresAt <= Date.now()
  ) return "qr_expired";
  const states: Record<AuthState, PublicLoginState> = {
    new: "not_requested",
    qr_pending: "waiting_scan",
    scanned: "scanned",
    capturing_context: "initializing",
    authenticated: "succeeded",
    baseline_sync: "succeeded",
    active: "succeeded",
    expired: "qr_expired",
    cancelled: "cancelled",
    no_account: "no_account",
    auth_required: credentialKind === "session" ? "login_required" : "failed",
    schema_changed: credentialKind === "session" ? "succeeded" : "failed",
    stopped: "succeeded",
    logged_out: "failed",
  };
  return states[snapshot.authState];
}

function projectHosting(
  snapshot: SessionSnapshot,
  credentialKind: CredentialKind,
): {
  state: PublicHostingState;
  automationEnabled: boolean;
  automationEffective: boolean;
  loginExpired: boolean;
  reloginRequired: boolean;
  credentialExpiresAt: null;
} {
  const loginExpired = snapshot.authState === "auth_required"
    && credentialKind === "session";
  const sourceDegraded = snapshot.sources.some(
    (source) => source.state === "error" || source.state === "schema_changed",
  );
  const automationEffective = snapshot.authState === "active"
    && snapshot.automationEnabled
    && snapshot.service.autoReplyEnabled
    && snapshot.service.selectedProviderConfigured;
  let state: PublicHostingState = "not_ready";
  if (loginExpired) state = "expired";
  else if (
    (snapshot.authState === "schema_changed" && credentialKind === "session")
    || sourceDegraded
  ) {
    state = "degraded";
  } else if (snapshot.authState === "authenticated" || snapshot.authState === "baseline_sync") {
    state = "initializing";
  } else if (snapshot.authState === "stopped" || (
    snapshot.authState === "active" && !automationEffective
  )) {
    state = "paused";
  } else if (snapshot.authState === "active") {
    state = "active";
  }
  return {
    state,
    automationEnabled: snapshot.automationEnabled,
    automationEffective,
    loginExpired,
    reloginRequired: loginExpired,
    credentialExpiresAt: null,
  };
}

function projectSource(source: SessionSnapshot["sources"][number] | undefined): PublicSource {
  return source
    ? {
        state: source.state,
        baselineComplete: source.baselineComplete,
        lastSuccessAt: nullableIsoTimestamp(source.lastSuccessAt),
        errorCode: source.lastErrorCode,
      }
    : {
        state: "pending",
        baselineComplete: false,
        lastSuccessAt: null,
        errorCode: null,
      };
}

async function contentPage(
  request: FastifyRequest,
  deps: PartnerApiDependencies,
  source: InboundSource,
): Promise<{
  items: PublicContentItem[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const account = requirePartnerAccount(request, deps.sessions);
  const query = contentQuery.parse(request.query);
  const cursor = query.cursor !== undefined
    ? decodeCursor(query.cursor, account.id, source)
    : undefined;
  const page = deps.sessions.listPartnerContent(
    account,
    source,
    query.limit,
    cursor,
  );
  return {
    items: page.items.map((item) => projectContentItem(source, item)),
    hasMore: page.hasMore,
    nextCursor: page.nextCursorData
      ? encodeCursor(account.id, source, page.nextCursorData)
      : null,
  };
}

interface PublicContentItem {
  id: string;
  source: InboundSource;
  authorName: string;
  text: string;
  occurredAt: string;
  discoveredAt: string;
  historical: boolean;
  replyEligible: boolean;
  reply: {
    state: ReplyState;
    text: string | null;
    messages: string[];
    errorCode: string | null;
    updatedAt: string;
  } | null;
}

function projectContentItem(
  source: InboundSource,
  item: PartnerContentItem,
): PublicContentItem {
  return {
    id: item.id,
    source,
    authorName: item.authorName,
    text: item.text,
    occurredAt: isoTimestamp(item.occurredAt),
    discoveredAt: isoTimestamp(item.discoveredAt),
    historical: item.historical,
    replyEligible: item.replyEligible,
    reply: item.reply
      ? {
          state: item.reply.state,
          text: item.reply.text,
          messages: item.reply.messages,
          errorCode: item.reply.errorCode,
          updatedAt: isoTimestamp(item.reply.updatedAt),
        }
      : null,
  };
}

function encodeCursor(
  accountId: string,
  source: InboundSource,
  row: PartnerContentCursor,
): string {
  const cursor: ContentCursor = {
    version: 1,
    accountId,
    source,
    discoveredAt: row.discoveredAt,
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  raw: string,
  accountId: string,
  source: InboundSource,
): Pick<ContentCursor, "discoveredAt" | "id"> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("invalid_cursor");
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error("invalid_cursor");
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    const cursor = cursorSchema.parse(decoded);
    if (cursor.accountId !== accountId || cursor.source !== source) {
      throw new Error("invalid_cursor");
    }
    return { discoveredAt: cursor.discoveredAt, id: cursor.id };
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_cursor") throw error;
    throw new Error("invalid_cursor", { cause: error });
  }
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function nullableIsoTimestamp(value: number | null): string | null {
  return value === null ? null : isoTimestamp(value);
}
