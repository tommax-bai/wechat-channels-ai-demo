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

interface DmCursorV1 {
  v: 1;
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

export interface WechatGateway {
  createLogin(qrTtlMs: number): Promise<PendingWechatLogin>;
  pollLogin(pending: PendingWechatLogin): Promise<LoginPollResult>;
  completeLoginCapture(session: PlatformSession): Promise<PlatformSession>;
  syncDirectMessages(session: PlatformSession, cursor: string | null): Promise<WechatSyncPage>;
  syncComments(session: PlatformSession, cursor: string | null): Promise<WechatSyncPage>;
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
        dmCursor: "",
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
    const endpoint = state.phase === "history" ? "dmHistory" : "dmNewMessages";
    const jar = this.transport.createJar(session.cookieJar);
    const context: RequestContext = {
      jar,
      uin: session.uin,
      finderUsername: session.finderUsername,
      userAgent: session.userAgent,
    };
    const result = state.phase === "history"
      ? await this.transport.request(
          "dmHistory",
          state.cursor ? { cookie: state.cursor } : {},
          context,
        )
      : await this.transport.request("dmNewMessages", { cookie: state.cursor }, context);
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
    const hasMore = directMessagePageHasMore(result.data, state.phase, endpoint);
    let nextCursor: string;
    if (state.phase === "history" && hasMore) {
      nextCursor = encodeDmCursor({
        phase: "history",
        cursor: requiredString(
          result.data,
          ["cookie", "nextCursor"],
          "dmHistory",
          "data.cookie",
        ),
      });
    } else if (state.phase === "history") {
      const loginCookie = await this.transport.request("dmLoginCookie", {}, context);
      const incrementalCursor = requiredString(
        loginCookie.data,
        ["cookie"],
        "dmLoginCookie",
        "data.cookie",
      );
      session.dmCursor = incrementalCursor;
      nextCursor = encodeDmCursor({ phase: "incremental", cursor: incrementalCursor });
    } else {
      const incrementalCursor = requiredString(
        result.data,
        ["cookie", "nextCursor"],
        "dmNewMessages",
        "data.cookie",
      );
      session.dmCursor = incrementalCursor;
      nextCursor = encodeDmCursor({ phase: "incremental", cursor: incrementalCursor });
    }
    session.cookieJar = serializeJar(jar);
    return {
      items,
      cursor: nextCursor,
      hasMore,
    };
  }

  async syncComments(session: PlatformSession, cursor: string | null): Promise<WechatSyncPage> {
    const state = parseCommentCursor(cursor);
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
        currentPage: state.postPage,
        pageSize: 20,
        userpageType: 0,
        stickyOrder: false,
      },
      context,
    );
    const posts = arrayAt(postsResult.data, ["list", "postList"], "postList");
    const postsHaveMore = pageHasMore(
      postsResult.data,
      posts,
      ["continueFlag", "hasMore"],
      20,
      "postList",
      "data.continueFlag",
    );
    if (posts.length === 0) {
      if (postsHaveMore) {
        throw new WechatApiError("schema_changed:post.empty_continuation", "postList", false);
      }
      if (state.postSnapshot.length > 0) {
        throw new WechatApiError("schema_changed:post.cursor_target_missing", "postList", false);
      }
      session.cookieJar = serializeJar(jar);
      return { items: [], cursor: null, hasMore: false };
    }
    const boundState = bindCommentPostCursor(
      state,
      posts,
      postsHaveMore,
    );
    const items: NormalizedInboundItem[] = [];
    const objectId = boundState.postObjectId;
    const exportId = boundState.postExportId;
    const commentResult = await this.transport.request(
      "commentList",
      {
        lastBuff: boundState.commentLastBuff,
        exportId,
        commentSelection: false,
        forMcn: false,
      },
      context,
    );
    const comments = arrayAt(commentResult.data, ["comment", "comments", "list"], "commentList");
    const commentsHaveMore = commentPageHasMore(commentResult.data, comments);
    for (const rawComment of comments) {
      items.push(...normalizeCommentTree(
        rawComment,
        session.finderUsername,
        objectId,
        exportId,
      ));
    }
    const nextState = nextCommentCursor(
      boundState,
      comments,
      commentResult.data,
      commentsHaveMore,
    );
    session.cookieJar = serializeJar(jar);
    return {
      items,
      cursor: nextState ? JSON.stringify(nextState) : null,
      hasMore: nextState !== null,
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

function parseDmCursor(raw: string | null): DmCursorV1 {
  if (raw === null) return { v: 1, phase: "history", cursor: null };
  try {
    const value = JSON.parse(raw) as Partial<DmCursorV1>;
    if (
      value.v !== 1
      || (value.phase !== "history" && value.phase !== "incremental")
      || (value.cursor !== null && typeof value.cursor !== "string")
      || (value.phase === "incremental" && !value.cursor)
    ) {
      throw new Error("invalid");
    }
    return value as DmCursorV1;
  } catch {
    throw new WechatApiError("schema_changed:dm.cursor", "dmHistory", false);
  }
}

function encodeDmCursor(value: Omit<DmCursorV1, "v">): string {
  return JSON.stringify({ v: 1, ...value } satisfies DmCursorV1);
}

function parseCommentCursor(raw: string | null): CommentCursorV2 {
  if (raw === null) {
    return emptyCommentCursor(1);
  }
  try {
    const value = JSON.parse(raw) as Partial<CommentCursorV2>;
    const postSnapshot = value.postSnapshot;
    if (
      value.v !== 2
      || !Number.isInteger(value.postPage)
      || (value.postPage ?? 0) < 1
      || !Number.isInteger(value.postIndex)
      || (value.postIndex ?? -1) < 0
      || typeof value.commentLastBuff !== "string"
      || (value.postObjectId !== null && typeof value.postObjectId !== "string")
      || (value.postExportId !== null && typeof value.postExportId !== "string")
      || !isCommentPostSnapshot(postSnapshot)
      || (
        value.postPageHasMore !== null
        && typeof value.postPageHasMore !== "boolean"
      )
    ) {
      throw new Error("invalid");
    }
    if (postSnapshot.length === 0) {
      if (
        value.postIndex !== 0
        || value.commentLastBuff !== ""
        || value.postObjectId !== null
        || value.postExportId !== null
        || value.postPageHasMore !== null
      ) {
        throw new Error("invalid");
      }
    } else {
      const postIndex = value.postIndex as number;
      const target = postSnapshot[postIndex];
      if (
        !target
        || value.postObjectId !== target.objectId
        || value.postExportId !== target.exportId
        || typeof value.postPageHasMore !== "boolean"
      ) {
        throw new Error("invalid");
      }
    }
    return value as CommentCursorV2;
  } catch {
    throw new WechatApiError("schema_changed:comment.cursor", "commentList", false);
  }
}

function emptyCommentCursor(postPage: number): CommentCursorV2 {
  return {
    v: 2,
    postPage,
    postIndex: 0,
    commentLastBuff: "",
    postObjectId: null,
    postExportId: null,
    postSnapshot: [],
    postPageHasMore: null,
  };
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

function requiredFlag(
  record: Record<string, unknown>,
  keys: readonly string[],
  endpoint: Parameters<typeof asRecord>[1],
  field: string,
): boolean {
  for (const key of keys) {
    const value = record[key];
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
  }
  throw new WechatApiError(`schema_changed:${field}`, endpoint, false);
}

function directMessagePageHasMore(
  data: Record<string, unknown>,
  phase: DmCursorV1["phase"],
  endpoint: "dmHistory" | "dmNewMessages",
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
  if (!present && phase === "incremental") return false;
  throw new WechatApiError("schema_changed:data.isContinue", endpoint, false);
}

function pageHasMore(
  data: Record<string, unknown>,
  rows: unknown[],
  keys: readonly string[],
  pageSize: number,
  endpoint: Parameters<typeof asRecord>[1],
  field: string,
): boolean {
  for (const key of keys) {
    const value = data[key];
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
  }
  if (rows.length < pageSize) return false;
  throw new WechatApiError(`schema_changed:${field}`, endpoint, false);
}

function commentPageHasMore(data: Record<string, unknown>, rows: unknown[]): boolean {
  for (const key of ["downContinueFlag", "continueFlag", "hasMore"]) {
    const value = data[key];
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
  }
  if (rows.length === 0) return false;
  const last = asRecord(rows.at(-1), "commentList", "comment");
  return requiredFlag(
    last,
    ["downContinueFlag"],
    "commentList",
    "comment.downContinueFlag",
  );
}

function bindCommentPostCursor(
  state: CommentCursorV2,
  posts: unknown[],
  postsHaveMore: boolean,
): CommentCursorV2 & { postObjectId: string; postExportId: string } {
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

  if (state.postSnapshot.length === 0) {
    const target = observed[state.postIndex];
    if (!target) {
      throw new WechatApiError("schema_changed:post.cursor_index", "postList", false);
    }
    return {
      ...state,
      postObjectId: target.objectId,
      postExportId: target.exportId,
      postSnapshot: observed,
      postPageHasMore: postsHaveMore,
    };
  }

  const target = state.postSnapshot[state.postIndex];
  if (!target || !observed.some((post) => samePostIdentity(post, target))) {
    throw new WechatApiError("schema_changed:post.cursor_target_missing", "postList", false);
  }
  if (
    state.postPageHasMore !== postsHaveMore
    || !samePostIdentitySet(observed, state.postSnapshot)
  ) {
    throw new WechatApiError("schema_changed:post.cursor_snapshot", "postList", false);
  }
  return state as CommentCursorV2 & { postObjectId: string; postExportId: string };
}

function assertUniquePostIdentities(posts: CommentPostIdentity[]): void {
  const identities = new Set(posts.map(postIdentityKey));
  if (identities.size !== posts.length) {
    throw new WechatApiError("schema_changed:post.duplicate_identity", "postList", false);
  }
}

function samePostIdentitySet(
  left: CommentPostIdentity[],
  right: CommentPostIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(postIdentityKey));
  return left.every((post) => rightKeys.has(postIdentityKey(post)));
}

function samePostIdentity(
  left: CommentPostIdentity,
  right: CommentPostIdentity,
): boolean {
  return left.objectId === right.objectId && left.exportId === right.exportId;
}

function postIdentityKey(post: CommentPostIdentity): string {
  return JSON.stringify([post.objectId, post.exportId]);
}

function nextCommentCursor(
  state: CommentCursorV2,
  comments: unknown[],
  commentData: Record<string, unknown>,
  commentsHaveMore: boolean,
): CommentCursorV2 | null {
  if (commentsHaveMore) {
    return {
      ...state,
      commentLastBuff: continuationBuffer(
        commentData,
        comments,
        "commentList",
        "comment.lastBuff",
      ),
    };
  }
  const nextPost = state.postSnapshot[state.postIndex + 1];
  if (nextPost) {
    return {
      ...state,
      postIndex: state.postIndex + 1,
      commentLastBuff: "",
      postObjectId: nextPost.objectId,
      postExportId: nextPost.exportId,
    };
  }
  if (!state.postPageHasMore) return null;
  return emptyCommentCursor(state.postPage + 1);
}

function continuationBuffer(
  data: Record<string, unknown>,
  rows: unknown[],
  endpoint: "postList" | "commentList",
  field: string,
): string {
  const direct = optionalString(data, ["lastBuff", "nextCursor"]);
  if (direct) return direct;
  const last = rows.length > 0 ? asRecord(rows.at(-1), endpoint, "row") : null;
  const nested = last ? optionalString(last, ["lastBuff", "nextCursor"]) : null;
  if (nested) return nested;
  throw new WechatApiError(`schema_changed:${field}`, endpoint, false);
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
