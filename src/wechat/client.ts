import { createHash, randomBytes } from "node:crypto";
import type { SerializedCookieJar } from "tough-cookie";
import type {
  AccountQrAsset,
  DirectMessageTarget,
  NormalizedInboundItem,
  PlatformSession,
  ReplyTarget,
} from "../types.js";
import {
  asRecord,
  epochMs,
  newClientId,
  numberLike,
  optionalString,
  requiredCursor,
  requiredString,
  DEFAULT_WECHAT_USER_AGENT,
  WechatApiError,
  type RequestContext,
} from "./transport.js";
import type { WechatTransport } from "./transport.js";
import type { WechatSessionCapturer } from "./browser-capture.js";

export interface PendingWechatLogin {
  token: string;
  cookieJar: SerializedCookieJar;
  issuedAt: number;
  expiresAt: number;
}

export type LoginPollResult =
  | { state: "waiting" | "scanned"; pending: PendingWechatLogin }
  | { state: "expired" | "cancelled" | "no_account"; pending: PendingWechatLogin }
  | { state: "capture_required"; session: PlatformSession }
  | { state: "confirmed"; session: PlatformSession };

export interface WechatSyncPage {
  items: NormalizedInboundItem[];
  cursor: string | null;
  hasMore: boolean;
}

export interface WechatSendResult {
  accepted: boolean;
  externalId: string | null;
}

const DM_IMAGE_CHUNK_BYTES = 512 * 1024;

/**
 * v2 drops the platform cursor that v2's predecessor carried in the incremental phase. Both phases
 * now read the history endpoint, and the incremental phase reads only its first page, so there is
 * no continuation token to keep. A retained v1 cursor is migrated on read.
 */
interface DmCursorV2 {
  v: 2;
  phase: "history" | "incremental";
  cursor: string | null;
}

interface CommentPostIdentity {
  objectId: string;
  exportId: string;
}

interface CommentCursorV2 {
  v: 2;
  postPage: number;
  postIndex: number;
  commentLastBuff: string;
  postObjectId: string | null;
  postExportId: string | null;
  postSnapshot: CommentPostIdentity[];
  postPageHasMore: boolean | null;
}

interface CommentObservationMarkerV3 {
  v: 3;
  observedPosts: boolean;
}

export interface WechatGateway {
  createLogin(qrTtlMs: number): Promise<PendingWechatLogin>;
  pollLogin(pending: PendingWechatLogin): Promise<LoginPollResult>;
  completeLoginCapture(session: PlatformSession): Promise<PlatformSession>;
  syncDirectMessages(session: PlatformSession, cursor: string | null): Promise<WechatSyncPage>;
  syncComments(
    session: PlatformSession,
    cursor: string | null,
    onPostsObserved?: (cursor: string) => void,
  ): Promise<WechatSyncPage>;
  sendReply(
    session: PlatformSession,
    target: ReplyTarget,
    text: string,
    clientId: string,
    beforeDispatch?: () => boolean,
  ): Promise<WechatSendResult>;
  sendImageReply(
    session: PlatformSession,
    target: DirectMessageTarget,
    asset: AccountQrAsset,
    clientId: string,
    beforeDispatch?: () => boolean,
  ): Promise<WechatSendResult>;
}

export class PrivateWechatGateway implements WechatGateway {
  constructor(
    private readonly transport: WechatTransport,
    private readonly sessionCapturer?: WechatSessionCapturer,
  ) {}

  async createLogin(qrTtlMs: number): Promise<PendingWechatLogin> {
    const jar = this.transport.createJar();
    const result = await this.transport.request("authLoginCode", {}, { jar });
    const token = requiredString(result.data, ["token"], "authLoginCode", "data.token");
    const issuedAt = Date.now();
    return {
      token,
      cookieJar: serializeJar(jar),
      issuedAt,
      expiresAt: issuedAt + qrTtlMs,
    };
  }

  async pollLogin(pending: PendingWechatLogin): Promise<LoginPollResult> {
    const jar = this.transport.createJar(pending.cookieJar);
    const result = await this.transport.request(
      "authLoginStatus",
      { token: pending.token },
      { jar },
      { token: pending.token },
    );
    const nextPending = { ...pending, cookieJar: serializeJar(jar) };
    const status = numberLike(result.data.status);
    const accountStatus = numberLike(result.data.acctStatus);
    if (status === 0) return { state: "waiting", pending: nextPending };
    if (status === 5 && accountStatus === 1) return { state: "scanned", pending: nextPending };
    if (status === 4) return { state: "expired", pending: nextPending };
    if (status === 3) return { state: "cancelled", pending: nextPending };
    if (status === 5 && accountStatus === 2) return { state: "no_account", pending: nextPending };
    if (status !== 1 || (accountStatus !== null && accountStatus !== 1)) {
      throw new WechatApiError("schema_changed:login_status", "authLoginStatus", false);
    }

    const preAuthContext: RequestContext = { jar };
    const authData = await this.transport.request("authData", {}, preAuthContext);
    const finder = asRecord(authData.data.finderUser, "authData", "data.finderUser");
    const finderUsername = requiredString(
      finder,
      ["finderUsername", "finder_username", "username"],
      "authData",
      "finderUsername",
    );
    const nickname = requiredString(
      finder,
      ["nickname", "nickName", "displayName"],
      "authData",
      "nickname",
    );
    const authContext: RequestContext = { jar, finderUsername };
    const helper = await this.transport.request("helperUploadParams", {}, authContext);
    const uin = requiredString(helper.data, ["uin", "wechatUin"], "helperUploadParams", "data.uin");
    return {
      state: "capture_required",
      session: {
        transportProfile: "legacy_root",
        cookieJar: serializeJar(jar),
        userAgent: DEFAULT_WECHAT_USER_AGENT,
        uin,
        finderUsername,
        nickname,
        token: pending.token,
        acquiredAt: Date.now(),
      },
    };
  }

  async completeLoginCapture(
    provisionalSession: PlatformSession,
  ): Promise<PlatformSession> {
    if (!this.sessionCapturer) {
      throw new WechatApiError(
        "browser_capture_unavailable",
        "authData",
        false,
      );
    }
    const session = await this.sessionCapturer.capture(provisionalSession);
    if (session.transportProfile !== "micro_v1" || !session.requestContext) {
      throw new WechatApiError(
        "schema_changed:request_context_missing",
        "authData",
        false,
      );
    }
    const verificationJar = this.transport.createJar(session.cookieJar);
    const verification = await this.transport.request(
      "authData",
      {},
      {
        jar: verificationJar,
        uin: session.uin,
        finderUsername: session.finderUsername,
        userAgent: session.userAgent,
        ...(session.requestContext
          ? { requestContext: session.requestContext }
          : {}),
      },
    );
    const verifiedFinder = asRecord(
      verification.data.finderUser,
      "authData",
      "data.finderUser",
    );
    const verifiedFinderUsername = requiredString(
      verifiedFinder,
      ["finderUsername", "finder_username", "username"],
      "authData",
      "finderUsername",
    );
    if (verifiedFinderUsername !== provisionalSession.finderUsername) {
      throw new WechatApiError(
        "browser_capture_identity_mismatch",
        "authData",
        false,
      );
    }
    session.cookieJar = serializeJar(verificationJar);
    session.nickname = requiredString(
      verifiedFinder,
      ["nickname", "nickName", "displayName"],
      "authData",
      "nickname",
    );
    return session;
  }

  async syncDirectMessages(session: PlatformSession, cursor: string | null): Promise<WechatSyncPage> {
    const state = parseDmCursor(cursor);
    // Both phases read the history endpoint. The platform's notify channel answers a successful
    // empty page while the mailbox holds unseen inbound messages — proven live on 2026-08-10, when
    // the history endpoint returned a 21:27 inbound text that the notify channel reported for
    // neither a stored nor a freshly issued cursor. A lane driven by it reports healthy while blind,
    // which is the worst failure this service can have, so it is no longer read at all.
    const endpoint = "dmHistory";
    const jar = this.transport.createJar(session.cookieJar);
    const context: RequestContext = {
      jar,
      uin: session.uin,
      finderUsername: session.finderUsername,
      userAgent: session.userAgent,
    };
    const result = await this.transport.request(
      "dmHistory",
      state.cursor ? { cookie: state.cursor } : {},
      context,
    );
    const messages = arrayAt(result.data, ["msg", "messages", "messageList"], endpoint);
    const sessionIds = [...new Set(messages.map((raw) => {
      const item = asRecord(raw, endpoint, "message");
      return optionalString(item, ["sessionId", "session_id"]);
    }).filter((value): value is string => Boolean(value)))];
    let participants = new Map<string, { id: string; name: string }>();
    try {
      participants = await this.loadParticipants(context, sessionIds);
    } catch (error) {
      if (error instanceof WechatApiError && error.code === "auth_required") throw error;
    }
    const items = messages.flatMap((raw): NormalizedInboundItem[] => {
      const message = asRecord(raw, endpoint, "message");
      const msgType = numberLike(message.msgType ?? message.messageType);
      if (msgType !== 1) return [];
      const fromUsername = requiredString(message, ["fromUsername", "from_username"], endpoint, "fromUsername");
      const toUsername = requiredString(message, ["toUsername", "to_username"], endpoint, "toUsername");
      if (fromUsername === session.finderUsername || toUsername !== session.finderUsername) return [];
      const textRecord = asRecord(message.textMsg ?? message.text_message, endpoint, "textMsg");
      const text = requiredString(textRecord, ["content", "text"], endpoint, "textMsg.content");
      const externalId = requiredString(
        message,
        ["svrMsgId", "svr_msg_id", "msgId", "messageId"],
        endpoint,
        "svrMsgId",
      );
      const sessionId = requiredString(message, ["sessionId", "session_id"], endpoint, "sessionId");
      const participant = participants.get(sessionId);
      return [{
        source: "dm",
        externalId,
        authorId: fromUsername,
        authorName: participant?.name ?? "视频号访客",
        text,
        occurredAt: epochMs(message.createTime ?? message.create_time ?? message.ts),
        target: {
          kind: "dm",
          sessionId,
          fromUsername: session.finderUsername,
          toUsername: fromUsername,
        },
        rawShapeVersion: 1,
      }];
    });
    // The platform's continuation flag still decides how far the baseline walks. After the baseline
    // the lane reads this first page only: at the polling cadence it always covers what arrived
    // since the last read, and dedup by immutable message ID keeps the repeated overlap harmless.
    const hasMore = state.phase === "history"
      && directMessagePageHasMore(result.data, endpoint);
    const nextCursor = hasMore
      ? encodeDmCursor({
          phase: "history",
          cursor: requiredCursor(result.data, ["cookie", "nextCursor"], "dmHistory", "data.cookie"),
        })
      : encodeDmCursor({ phase: "incremental", cursor: null });
    session.cookieJar = serializeJar(jar);
    return {
      items,
      cursor: nextCursor,
      hasMore,
    };
  }

  async syncComments(
    session: PlatformSession,
    cursor: string | null,
    onPostsObserved?: (cursor: string) => void,
  ): Promise<WechatSyncPage> {
    const marker = parseCommentObservationMarker(cursor);
    const jar = this.transport.createJar(session.cookieJar);
    const context: RequestContext = {
      jar,
      uin: session.uin,
      finderUsername: session.finderUsername,
      userAgent: session.userAgent,
      ...(session.requestContext
        ? { requestContext: session.requestContext }
        : {}),
    };
    const postsResult = await this.transport.request(
      "postList",
      {
        currentPage: 1,
        pageSize: 3,
        userpageType: 0,
        stickyOrder: false,
      },
      context,
    );
    const rawPosts = arrayAt(postsResult.data, ["list", "postList"], "postList");
    if (rawPosts.length === 0) {
      if (marker.observedPosts) {
        throw new WechatApiError("platform_post_list_empty", "postList", false);
      }
      session.cookieJar = serializeJar(jar);
      return {
        items: [],
        cursor: encodeCommentObservationMarker(false),
        hasMore: false,
      };
    }

    const posts = normalizeCommentPosts(rawPosts.slice(0, 3));
    if (!marker.observedPosts) {
      onPostsObserved?.(encodeCommentObservationMarker(true));
    }
    const items: NormalizedInboundItem[] = [];
    for (const post of posts) {
      const commentResult = await this.transport.request(
        "commentList",
        {
          lastBuff: "",
          exportId: post.exportId,
          commentSelection: false,
          forMcn: false,
        },
        context,
      );
      const comments = arrayAt(commentResult.data, ["comment", "comments", "list"], "commentList");
      for (const rawComment of comments) {
        items.push(...normalizeCommentTree(
          rawComment,
          session.finderUsername,
          post.objectId,
          post.exportId,
        ));
      }
    }
    session.cookieJar = serializeJar(jar);
    return {
      items,
      cursor: encodeCommentObservationMarker(true),
      hasMore: false,
    };
  }

  async sendReply(
    session: PlatformSession,
    target: ReplyTarget,
    text: string,
    clientId = newClientId(),
    beforeDispatch?: () => boolean,
  ): Promise<WechatSendResult> {
    const jar = this.transport.createJar(session.cookieJar);
    const context: RequestContext = {
      jar,
      uin: session.uin,
      finderUsername: session.finderUsername,
      userAgent: session.userAgent,
      ...(session.requestContext
        ? { requestContext: session.requestContext }
        : {}),
    };
    try {
      const result = target.kind === "dm"
        ? await this.transport.request("dmSendText", {
            msgPack: {
              sessionId: target.sessionId,
              fromUsername: target.fromUsername,
              toUsername: target.toUsername,
              msgType: 1,
              textMsg: { content: text },
              cliMsgId: clientId,
            },
          }, context, {}, beforeDispatch)
        : await this.transport.request("commentCreate", {
            exportId: target.postId,
            rootCommentId: target.rootCommentId,
            replyCommentId: target.parentCommentId,
            content: text,
            clientId,
            comment: target.commentContext,
          }, context, {}, beforeDispatch);
      const externalId = target.kind === "dm"
        ? optionalString(result.data, ["svrMsgId"])
        : extractCommentAck(result.data);
      if (!externalId) {
        throw new WechatApiError("platform_ack_missing", target.kind === "dm" ? "dmSendText" : "commentCreate", true);
      }
      return { accepted: true, externalId };
    } finally {
      try {
        session.cookieJar = serializeJar(jar);
      } catch {
        // The observed platform outcome stays authoritative if refreshed cookies cannot be serialized.
      }
    }
  }

  async sendImageReply(
    session: PlatformSession,
    target: DirectMessageTarget,
    asset: AccountQrAsset,
    clientId = newClientId(),
    beforeDispatch?: () => boolean,
  ): Promise<WechatSendResult> {
    if (
      !(asset.bytes instanceof Uint8Array)
      || (asset.mimeType !== "image/png" && asset.mimeType !== "image/jpeg")
    ) {
      throw new WechatApiError("image_asset_invalid", "dmUploadMedia", false);
    }
    const bytes = Buffer.from(asset.bytes);
    if (bytes.byteLength === 0) {
      throw new WechatApiError("image_asset_empty", "dmUploadMedia", false);
    }

    const jar = this.transport.createJar(session.cookieJar);
    const context: RequestContext = {
      jar,
      uin: session.uin,
      finderUsername: session.finderUsername,
      userAgent: session.userAgent,
    };
    try {
      const chunks = Math.ceil(bytes.byteLength / DM_IMAGE_CHUNK_BYTES);
      const aesKey = randomBytes(32).toString("base64");
      const md5 = createHash("md5").update(bytes).digest("hex");
      let imgMsg: Record<string, unknown> | null = null;

      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const start = chunk * DM_IMAGE_CHUNK_BYTES;
        const content = bytes.subarray(
          start,
          Math.min(start + DM_IMAGE_CHUNK_BYTES, bytes.byteLength),
        );
        const upload = await this.transport.request("dmUploadMedia", {
          content: `data:application/octet-stream;base64,${content.toString("base64")}`,
          chunk,
          chunks,
          fromUsername: target.fromUsername,
          toUsername: target.toUsername,
          aesKey,
          mediaSize: bytes.byteLength,
          mediaType: 3,
          md5,
        }, context, {}, beforeDispatch);
        if (chunk === chunks - 1) {
          imgMsg = asRecord(upload.data.imgMsg, "dmUploadMedia", "data.imgMsg");
        }
      }

      if (!imgMsg) {
        throw new WechatApiError("schema_changed:data.imgMsg", "dmUploadMedia", false);
      }
      const result = await this.transport.request("dmSendText", {
        msgPack: {
          sessionId: target.sessionId,
          fromUsername: target.fromUsername,
          toUsername: target.toUsername,
          msgType: 3,
          imgMsg,
          cliMsgId: clientId,
        },
      }, context, {}, beforeDispatch);
      const externalId = optionalString(result.data, ["svrMsgId"]);
      if (!externalId) {
        throw new WechatApiError("platform_ack_missing", "dmSendText", true);
      }
      return { accepted: true, externalId };
    } finally {
      try {
        session.cookieJar = serializeJar(jar);
      } catch {
        // The observed platform outcome stays authoritative if refreshed cookies cannot be serialized.
      }
    }
  }

  private async loadParticipants(
    context: RequestContext,
    sessionIds: string[],
  ): Promise<Map<string, { id: string; name: string }>> {
    if (sessionIds.length === 0) return new Map();
    const result = await this.transport.request(
      "dmSessionInfo",
      { sessionId: sessionIds.slice(0, 50) },
      context,
    );
    const rows = arrayAt(result.data, ["sessionInfo", "sessionList", "list"], "dmSessionInfo");
    const map = new Map<string, { id: string; name: string }>();
    for (const raw of rows) {
      const row = asRecord(raw, "dmSessionInfo", "sessionInfo");
      const sessionId = requiredString(row, ["sessionId", "session_id"], "dmSessionInfo", "sessionId");
      const userValue = row.userInfo ?? row.user ?? row.participant;
      const user = userValue && typeof userValue === "object"
        ? asRecord(userValue, "dmSessionInfo", "userInfo")
        : row;
      const id = requiredString(user, ["username", "finderUsername", "id"], "dmSessionInfo", "userInfo.username");
      const name = optionalString(user, ["nickname", "nickName", "displayName"]) ?? "视频号访客";
      map.set(sessionId, { id, name });
    }
    return map;
  }
}

function arrayAt(
  record: Record<string, unknown>,
  keys: readonly string[],
  endpoint: Parameters<typeof asRecord>[1],
): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  throw new WechatApiError(`schema_changed:${keys[0] ?? "array"}`, endpoint, false);
}

function parseDmCursor(raw: string | null): DmCursorV2 {
  if (raw === null) return { v: 2, phase: "history", cursor: null };
  try {
    const value = JSON.parse(raw) as { v?: unknown; phase?: unknown; cursor?: unknown };
    if (value.v !== 1 && value.v !== 2) throw new Error("invalid");
    if (value.phase !== "history" && value.phase !== "incremental") throw new Error("invalid");
    if (value.cursor !== null && value.cursor !== undefined && typeof value.cursor !== "string") {
      throw new Error("invalid");
    }
    // A retained v1 incremental cursor addressed the abandoned notify channel. Its phase is what
    // matters — it says the baseline is behind us — while its token no longer means anything, so it
    // is dropped rather than replayed against a different endpoint.
    if (value.phase === "incremental") return { v: 2, phase: "incremental", cursor: null };
    return { v: 2, phase: "history", cursor: value.cursor ?? null };
  } catch {
    throw new WechatApiError("schema_changed:dm.cursor", "dmHistory", false);
  }
}

function encodeDmCursor(value: Omit<DmCursorV2, "v">): string {
  return JSON.stringify({ v: 2, ...value } satisfies DmCursorV2);
}

function parseCommentObservationMarker(raw: string | null): CommentObservationMarkerV3 {
  if (raw === null) return { v: 3, observedPosts: false };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.v === 2) {
      parseLegacyCommentCursor(value);
      return { v: 3, observedPosts: true };
    }
    if (value.v !== 3 || typeof value.observedPosts !== "boolean") {
      throw new Error("invalid");
    }
    return { v: 3, observedPosts: value.observedPosts };
  } catch {
    throw new WechatApiError("schema_changed:comment.cursor", "commentList", false);
  }
}

function parseLegacyCommentCursor(value: Record<string, unknown>): CommentCursorV2 {
  const candidate = value as unknown as Partial<CommentCursorV2>;
  const postSnapshot = candidate.postSnapshot;
  if (
    candidate.v !== 2
    || !Number.isInteger(candidate.postPage)
    || (candidate.postPage ?? 0) < 1
    || !Number.isInteger(candidate.postIndex)
    || (candidate.postIndex ?? -1) < 0
    || typeof candidate.commentLastBuff !== "string"
    || (candidate.postObjectId !== null && typeof candidate.postObjectId !== "string")
    || (candidate.postExportId !== null && typeof candidate.postExportId !== "string")
    || !isCommentPostSnapshot(postSnapshot)
    || (
      candidate.postPageHasMore !== null
      && typeof candidate.postPageHasMore !== "boolean"
    )
  ) {
    throw new Error("invalid");
  }
  if (postSnapshot.length === 0) {
    if (
      candidate.postIndex !== 0
      || candidate.commentLastBuff !== ""
      || candidate.postObjectId !== null
      || candidate.postExportId !== null
      || candidate.postPageHasMore !== null
    ) {
      throw new Error("invalid");
    }
  } else {
    assertUniquePostIdentities(postSnapshot);
    const target = postSnapshot[candidate.postIndex as number];
    if (
      !target
      || candidate.postObjectId !== target.objectId
      || candidate.postExportId !== target.exportId
      || typeof candidate.postPageHasMore !== "boolean"
    ) {
      throw new Error("invalid");
    }
  }
  return candidate as CommentCursorV2;
}

function isCommentPostSnapshot(value: unknown): value is CommentPostIdentity[] {
  return Array.isArray(value) && value.every((post) => {
    if (!post || typeof post !== "object" || Array.isArray(post)) return false;
    const candidate = post as Partial<CommentPostIdentity>;
    return typeof candidate.objectId === "string"
      && candidate.objectId.length > 0
      && typeof candidate.exportId === "string"
      && candidate.exportId.length > 0;
  });
}

export function encodeCommentObservationMarker(observedPosts: boolean): string {
  return JSON.stringify({ v: 3, observedPosts } satisfies CommentObservationMarkerV3);
}

/** Only the baseline walks pages, so the history endpoint must always state whether more remain. */
function directMessagePageHasMore(
  data: Record<string, unknown>,
  endpoint: "dmHistory",
): boolean {
  let parsed: boolean | null = null;
  let present = false;
  for (const key of ["isContinue", "hasMore"]) {
    if (!Object.hasOwn(data, key)) continue;
    present = true;
    const value = data[key];
    const current =
      value === true || value === 1 || value === "1"
        ? true
        : value === false || value === 0 || value === "0"
          ? false
          : null;
    if (current === null || (parsed !== null && parsed !== current)) {
      throw new WechatApiError("schema_changed:data.isContinue", endpoint, false);
    }
    parsed = current;
  }
  if (present && parsed !== null) return parsed;
  throw new WechatApiError("schema_changed:data.isContinue", endpoint, false);
}

function normalizeCommentPosts(posts: unknown[]): CommentPostIdentity[] {
  const observed = posts.map((rawPost) => {
    const post = asRecord(rawPost, "postList", "post");
    return {
      objectId: requiredString(
        post,
        ["objectId", "object_id"],
        "postList",
        "post.objectId",
      ),
      exportId: requiredString(
        post,
        ["exportId", "export_id"],
        "postList",
        "post.exportId",
      ),
    };
  });
  assertUniquePostIdentities(observed);
  return observed;
}

function assertUniquePostIdentities(posts: CommentPostIdentity[]): void {
  const identities = new Set(posts.map(postIdentityKey));
  if (identities.size !== posts.length) {
    throw new WechatApiError("schema_changed:post.duplicate_identity", "postList", false);
  }
}

function postIdentityKey(post: CommentPostIdentity): string {
  return JSON.stringify([post.objectId, post.exportId]);
}

function normalizeCommentTree(
  rawComment: unknown,
  ownUsername: string,
  objectId: string,
  exportId: string,
  rootCommentId?: string,
): NormalizedInboundItem[] {
  const comment = asRecord(rawComment, "commentList", "comment");
  const commentId = requiredString(
    comment,
    ["commentId", "comment_id"],
    "commentList",
    "comment.commentId",
  );
  const childrenValue = comment.levelTwoComment;
  if (childrenValue !== undefined && !Array.isArray(childrenValue)) {
    throw new WechatApiError(
      "schema_changed:comment.levelTwoComment",
      "commentList",
      false,
    );
  }
  const children = childrenValue ?? [];
  const rootId = rootCommentId ?? commentId;
  const descendants = children.flatMap((child) => normalizeCommentTree(
    child,
    ownUsername,
    objectId,
    exportId,
    rootId,
  ));
  const commentContext = sanitizeCommentContext(comment, commentId);
  const username = optionalString(comment, ["username", "finderUsername"])?.trim();
  if (!commentContext || (username && username === ownUsername)) return descendants;

  const text = requiredString(
    comment,
    ["commentContent", "content", "text"],
    "commentList",
    "comment.content",
  );
  return [{
    source: "comment",
    externalId: `${objectId}:${commentId}`,
    authorId: username || opaqueCommentAuthorId(commentId),
    authorName: optionalString(comment, ["commentNickname", "nickname"]) ?? "视频号用户",
    text,
    occurredAt: epochMs(comment.commentCreatetime ?? comment.createTime),
    target: {
      kind: "comment",
      postId: exportId,
      rootCommentId: rootId,
      parentCommentId: commentId,
      commentContext,
    },
    rawShapeVersion: 1,
  }, ...descendants];
}

function opaqueCommentAuthorId(commentId: string): string {
  return `comment_opaque_${createHash("sha256")
    .update(`comment|${commentId}`, "utf8")
    .digest("hex")}`;
}

function sanitizeCommentContext(
  comment: Record<string, unknown>,
  normalizedCommentId: string,
): Record<string, unknown> | null {
  const stringFields = [
    "commentId",
    "commentNickname",
    "commentContent",
    "commentHeadurl",
    "commentCreatetime",
    "lastBuff",
    "username",
  ] as const;
  const numberFields = [
    "commentLikeCount",
    "downContinueFlag",
    "visibleFlag",
    "displayFlag",
    "blacklistFlag",
    "likeFlag",
  ] as const;
  for (const field of stringFields) {
    if (typeof comment[field] !== "string") {
      return null;
    }
  }
  for (const field of numberFields) {
    if (typeof comment[field] !== "number" || !Number.isFinite(comment[field])) {
      return null;
    }
  }
  if (typeof comment.readFlag !== "boolean") {
    return null;
  }
  if (comment.commentId !== normalizedCommentId) {
    return null;
  }
  return {
    levelTwoComment: [],
    commentId: comment.commentId,
    commentNickname: comment.commentNickname,
    commentContent: comment.commentContent,
    commentHeadurl: comment.commentHeadurl,
    commentCreatetime: comment.commentCreatetime,
    commentLikeCount: comment.commentLikeCount,
    lastBuff: comment.lastBuff,
    downContinueFlag: comment.downContinueFlag,
    visibleFlag: comment.visibleFlag,
    readFlag: comment.readFlag,
    displayFlag: comment.displayFlag,
    username: comment.username,
    blacklistFlag: comment.blacklistFlag,
    likeFlag: comment.likeFlag,
  };
}

function extractCommentAck(data: Record<string, unknown>): string | null {
  const comment = data.comment;
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) return null;
  return optionalString(comment as Record<string, unknown>, ["commentId", "comment_id"]);
}

function serializeJar(jar: ReturnType<WechatTransport["createJar"]>): SerializedCookieJar {
  const serialized = jar.serializeSync();
  if (!serialized) throw new Error("cookie jar serialization failed");
  return serialized;
}
