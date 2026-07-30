export type AuthState =
  | "new"
  | "qr_pending"
  | "scanned"
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
export type SourceState = "pending" | "healthy" | "auth_required" | "schema_changed" | "error";
export type ReplyState =
  | "queued"
  | "generating"
  | "generated"
  | "sending"
  | "confirmed"
  | "failed"
  | "submitted_unknown";

export interface PlatformSession {
  transportProfile: "legacy_root";
  cookieJar: SerializedCookieJar;
  dmCursor: string;
  userAgent: string;
  uin: string;
  finderUsername: string;
  nickname: string;
  token: string;
  acquiredAt: number;
}

export interface DirectMessageTarget {
  kind: "dm";
  sessionId: string;
  fromUsername: string;
  toUsername: string;
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
}

export interface ReplyModelResult {
  text: string;
  model: string;
  requestId?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface SessionSnapshot {
  authState: AuthState;
  accountDisplayName: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: number | null;
  automationEnabled: boolean;
  expiresAt: number;
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
    replyState: ReplyState | null;
    replyErrorCode: string | null;
  }>;
  service: {
    autoReplyEnabled: boolean;
    modelConfigured: boolean;
  };
}
import type { SerializedCookieJar } from "tough-cookie";
