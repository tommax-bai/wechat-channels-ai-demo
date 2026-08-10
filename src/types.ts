export type AuthState =
  | "new"
  | "qr_pending"
  | "scanned"
  | "capturing_context"
  | "authenticated"
  | "baseline_sync"
  | "active"
  | "expired"
  | "cancelled"
  | "no_account"
  | "auth_required"
  | "schema_changed"
  | "stopped"
  | "logged_out";

export type InboundSource = "dm" | "comment";
export type ReplyProvider = "chat-llm" | "funnel";
export type SourceState = "pending" | "healthy" | "auth_required" | "schema_changed" | "error";
export type ReplyState =
  | "queued"
  | "generating"
  | "generated"
  | "sending"
  | "confirmed"
  | "skipped"
  | "failed"
  | "submitted_unknown";

export interface WechatRequestContext {
  version: 1;
  aid: string;
  pageUrl: string;
  commonBody: {
    logFinderId: string;
    logFinderUin: string | null;
    rawKeyBuff: string;
    pluginSessionId: string | null;
    reqScene: number;
    scene: number;
  };
  headers: {
    fingerprintDeviceId: string;
    wechatUin: string;
  };
}

export interface PlatformSession {
  transportProfile: "legacy_root" | "micro_v1";
  cookieJar: SerializedCookieJar;
  dmCursor: string;
  userAgent: string;
  uin: string;
  finderUsername: string;
  nickname: string;
  token: string;
  acquiredAt: number;
  requestContext?: WechatRequestContext;
}

export interface DirectMessageTarget {
  kind: "dm";
  sessionId: string;
  fromUsername: string;
  toUsername: string;
}

export interface AccountQrAsset {
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

export interface AccountWechatQrMetadata {
  configured: boolean;
  mimeType: "image/png" | "image/jpeg" | null;
  byteLength: number | null;
  updatedAt: number | null;
}

export interface AccountWechatQrPreview extends AccountWechatQrMetadata {
  dataUrl: string | null;
}

export interface CommentTarget {
  kind: "comment";
  postId: string;
  rootCommentId: string;
  parentCommentId: string;
  commentContext: Record<string, unknown>;
}

export type ReplyTarget = DirectMessageTarget | CommentTarget;

export interface NormalizedInboundItem {
  source: InboundSource;
  externalId: string;
  authorId: string;
  authorName: string;
  text: string;
  occurredAt: number;
  target: ReplyTarget;
  rawShapeVersion: number;
}

export interface ReplyModelInput {
  source: InboundSource;
  authorName: string;
  text: string;
  jobNumber?: string;
  conversationId?: string;
  messageId?: string;
}

export interface ReplyModelResult {
  text: string;
  messages?: string[];
  disposition?: "reply" | "skip";
  action?: "send_wechat_qr";
  model: string;
  requestId?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface SessionSnapshot {
  sessionId: string;
  authState: AuthState;
  authErrorCode: string | null;
  accountDisplayName: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: number | null;
  automationEnabled: boolean;
  replyProvider: ReplyProvider;
  funnelJobNumber: string | null;
  wechatQr: AccountWechatQrMetadata;
  sources: Array<{
    source: InboundSource;
    state: SourceState;
    baselineComplete: boolean;
    lastSuccessAt: number | null;
    lastErrorCode: string | null;
  }>;
  timeline: Array<{
    id: string;
    source: InboundSource;
    authorName: string;
    text: string;
    occurredAt: number;
    historical: boolean;
    replyText: string | null;
    replyAction: "send_wechat_qr" | null;
    replyState: ReplyState | null;
    replyErrorCode: string | null;
  }>;
  service: {
    autoReplyEnabled: boolean;
    modelConfigured: boolean;
    chatReplyConfigured: boolean;
    funnelReplyConfigured: boolean;
    selectedProviderConfigured: boolean;
  };
}

export interface ConnectSnapshot {
  accountBound: boolean;
  authState: AuthState;
  authErrorCode: string | null;
  accountDisplayName: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: number | null;
  automationEnabled: boolean;
  replyProvider: ReplyProvider;
  funnelJobNumber: string | null;
  wechatQr: AccountWechatQrPreview | null;
}

export interface SharedSessionSummary {
  sessionId: string;
  accountDisplayName: string;
  authState: AuthState;
  automationEnabled: boolean;
  replyProvider: ReplyProvider;
  funnelJobNumber: string | null;
  wechatQr: AccountWechatQrMetadata;
}

export interface PartnerContentCursor {
  discoveredAt: number;
  id: string;
}

export interface PartnerContentItem {
  id: string;
  authorName: string;
  text: string;
  occurredAt: number;
  discoveredAt: number;
  historical: boolean;
  replyEligible: boolean;
  reply: {
    state: ReplyState;
    text: string | null;
    messages: string[];
    errorCode: string | null;
    updatedAt: number;
  } | null;
}

export interface PartnerContentPage {
  items: PartnerContentItem[];
  hasMore: boolean;
  nextCursorData: PartnerContentCursor | null;
}
import type { SerializedCookieJar } from "tough-cookie";
