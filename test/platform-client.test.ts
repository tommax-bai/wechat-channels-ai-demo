import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { PrivateWechatGateway } from "../src/wechat/client.js";
import type { WechatSessionCapturer } from "../src/wechat/browser-capture.js";
import { WechatTransport } from "../src/wechat/transport.js";
import { fakePlatformSession } from "./helpers.js";

describe("PrivateWechatGateway parsers", () => {
  it("requests a QR token without a browser and maps status 4 with missing acctStatus to expired", async () => {
    const calls: string[] = [];
    const transport = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        return response(url.includes("auth_login_code")
          ? { errCode: 0, data: { token: "qr-token" } }
          : { errCode: 0, data: { status: 4 } });
      },
    });
    const gateway = new PrivateWechatGateway(transport);
    const pending = await gateway.createLogin(120_000);
    const result = await gateway.pollLogin(pending);

    expect(pending.token).toBe("qr-token");
    expect(result.state).toBe("expired");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("token=qr-token");
  });

  it("captures and revalidates first-party context before confirming login", async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const transport = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, headers: new Headers(init?.headers) });
        if (url.pathname.endsWith("/auth_login_code")) {
          return response({ errCode: 0, data: { token: "qr-token" } });
        }
        if (url.pathname.endsWith("/auth_login_status")) {
          return response({ errCode: 0, data: { status: 1, acctStatus: 1 } });
        }
        if (url.pathname.endsWith("/auth_data")) {
          return response({
            errCode: 0,
            data: {
              finderUser: {
                finderUsername: "finder-self",
                nickname: "测试视频号",
              },
            },
          });
        }
        if (url.pathname.endsWith("/helper_upload_params")) {
          return response({ errCode: 0, data: { uin: "10001" } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    const capturedContext = fakePlatformSession().requestContext;
    if (!capturedContext) throw new Error("missing fake captured context");
    const capturer: WechatSessionCapturer = {
      capture: async (session) => ({
        ...session,
        transportProfile: "micro_v1",
        requestContext: capturedContext,
      }),
    };
    const gateway = new PrivateWechatGateway(transport, capturer);

    const pending = await gateway.createLogin(120_000);
    const polled = await gateway.pollLogin(pending);
    expect(polled.state).toBe("capture_required");
    if (polled.state !== "capture_required") {
      throw new Error("login was not ready for capture");
    }
    const session = await gateway.completeLoginCapture(polled.session);

    expect(session.transportProfile).toBe("micro_v1");
    expect(session.finderUsername).toBe("finder-self");
    const authCalls = calls.filter((call) => call.url.pathname.endsWith("/auth_data"));
    expect(authCalls).toHaveLength(2);
    expect([...authCalls[0]!.url.searchParams.keys()]).toEqual([]);
    expect([...authCalls[1]!.url.searchParams.keys()].sort()).toEqual([
      "_aid",
      "_pageUrl",
      "_rid",
    ]);
    expect(authCalls[1]!.headers.get("finger-print-device-id"))
      .toBe("fingerprint-test");
  });

  it("scans only the first three posts once and ignores all continuation markers", async () => {
    const postBodies: Array<Record<string, unknown>> = [];
    const commentBodies: Array<Record<string, unknown>> = [];
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          postBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return response({
            errCode: 0,
            data: {
              list: Array.from({ length: 5 }, (_, index) => ({
                objectId: `object-${index + 1}`,
                exportId: `export-${index + 1}`,
              })),
              continueFlag: 1,
              lastBuff: "post-continuation-must-be-ignored",
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          commentBodies.push(body);
          return response({
            errCode: 0,
            data: {
              comment: [commentRecord({
                commentId: `comment-${String(body.exportId)}`,
                commentContent: `来自 ${String(body.exportId)}`,
                lastBuff: "comment-continuation-must-be-ignored",
                downContinueFlag: 1,
              })],
              lastBuff: "comment-continuation-must-be-ignored",
              downContinueFlag: 1,
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));

    const page = await gateway.syncComments(fakePlatformSession(), null);

    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]).toMatchObject({
      currentPage: 1,
      pageSize: 3,
      userpageType: 0,
      stickyOrder: false,
    });
    expect(postBodies[0]).not.toHaveProperty("lastBuff");
    expect(postBodies[0]).not.toHaveProperty("onlyUnread");
    expect(commentBodies.map((body) => ({
      exportId: body.exportId,
      lastBuff: body.lastBuff,
    }))).toEqual([
      { exportId: "export-1", lastBuff: "" },
      { exportId: "export-2", lastBuff: "" },
      { exportId: "export-3", lastBuff: "" },
    ]);
    expect(page.items.map((item) => item.externalId)).toEqual([
      "object-1:comment-export-1",
      "object-2:comment-export-2",
      "object-3:comment-export-3",
    ]);
    expect(page.items.map((item) => item.target.kind === "comment" && item.target.postId))
      .toEqual(["export-1", "export-2", "export-3"]);
    expect(page.cursor && JSON.parse(page.cursor)).toEqual({ v: 3, observedPosts: true });
    expect(page.hasMore).toBe(false);
  });

  it("keeps repeated bounded reads on the same stable comment identity", async () => {
    let postRequests = 0;
    const commentLastBuffs: unknown[] = [];
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          postRequests += 1;
          return response({
            errCode: 0,
            data: { list: [{ objectId: "object-stable", exportId: "export-stable" }] },
          });
        }
        if (url.includes("/comment/comment_list")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          commentLastBuffs.push(body.lastBuff);
          return response({
            errCode: 0,
            data: { comment: [commentRecord({ commentId: "comment-stable" })] },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));
    const session = fakePlatformSession();

    const first = await gateway.syncComments(session, null);
    const second = await gateway.syncComments(session, first.cursor);

    expect(postRequests).toBe(2);
    expect(commentLastBuffs).toEqual(["", ""]);
    expect(first.items[0]?.externalId).toBe("object-stable:comment-stable");
    expect(second.items[0]?.externalId).toBe(first.items[0]?.externalId);
    expect(first.hasMore).toBe(false);
    expect(second.hasMore).toBe(false);
  });

  it("accepts an empty list before observing posts and rejects one afterward", async () => {
    let postRequests = 0;
    let commentRequests = 0;
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          postRequests += 1;
          return response({
            errCode: 0,
            data: {
              list: postRequests === 2
                ? [{ objectId: "object-first", exportId: "export-first" }]
                : [],
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          commentRequests += 1;
          return response({ errCode: 0, data: { comment: [] } });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));
    const session = fakePlatformSession();

    const empty = await gateway.syncComments(session, null);
    const observed = await gateway.syncComments(session, empty.cursor);

    expect(empty.items).toEqual([]);
    expect(empty.cursor && JSON.parse(empty.cursor)).toEqual({ v: 3, observedPosts: false });
    expect(observed.cursor && JSON.parse(observed.cursor)).toEqual({ v: 3, observedPosts: true });
    await expect(gateway.syncComments(session, observed.cursor)).rejects.toMatchObject({
      code: "platform_post_list_empty",
      endpoint: "postList",
      ambiguous: false,
    });
    expect(commentRequests).toBe(1);
  });

  it("uses a legacy v2 cursor only as evidence that posts were observed", async () => {
    const commentBodies: Array<Record<string, unknown>> = [];
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          return response({
            errCode: 0,
            data: {
              list: [{ objectId: "object-current", exportId: "export-current" }],
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          commentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return response({ errCode: 0, data: { comment: [] } });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));
    const legacyCursor = JSON.stringify({
      v: 2,
      postPage: 7,
      postIndex: 1,
      commentLastBuff: "legacy-comment-continuation",
      postObjectId: "object-old-b",
      postExportId: "export-old-b",
      postSnapshot: [
        { objectId: "object-old-a", exportId: "export-old-a" },
        { objectId: "object-old-b", exportId: "export-old-b" },
      ],
      postPageHasMore: true,
    });

    const page = await gateway.syncComments(fakePlatformSession(), legacyCursor);

    expect(commentBodies).toHaveLength(1);
    expect(commentBodies[0]).toMatchObject({
      exportId: "export-current",
      lastBuff: "",
    });
    expect(page.cursor && JSON.parse(page.cursor)).toEqual({ v: 3, observedPosts: true });
    expect(page.hasMore).toBe(false);
  });

  it("checkpoints the first observed post list before any comment request can fail", async () => {
    const events: string[] = [];
    const checkpoints: string[] = [];
    let postRequests = 0;
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          postRequests += 1;
          return response({
            errCode: 0,
            data: {
              list: postRequests === 1
                ? [{ objectId: "object-first", exportId: "export-first" }]
                : [],
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          events.push("comment-request");
          throw new Error("comment transport failed");
        }
        throw new Error(`unexpected ${url}`);
      },
    }));

    await expect(gateway.syncComments(fakePlatformSession(), null, (cursor) => {
      events.push("checkpoint");
      checkpoints.push(cursor);
    })).rejects.toMatchObject({
      code: "network_error",
      endpoint: "commentList",
      ambiguous: false,
    });

    expect(events).toEqual(["checkpoint", "comment-request"]);
    expect(checkpoints.map((cursor) => JSON.parse(cursor))).toEqual([
      { v: 3, observedPosts: true },
    ]);
    await expect(gateway.syncComments(fakePlatformSession(), checkpoints[0]!))
      .rejects.toMatchObject({
        code: "platform_post_list_empty",
        endpoint: "postList",
        ambiguous: false,
      });
    expect(events).toEqual(["checkpoint", "comment-request"]);
  });

  it("treats a legacy v2 cursor as observed when the current post list is empty", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async () => response({
        errCode: 0,
        data: { list: [], continueFlag: 0 },
      }),
    }));

    await expect(gateway.syncComments(fakePlatformSession(), JSON.stringify({
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: "object-old",
      postExportId: "export-old",
      postSnapshot: [{ objectId: "object-old", exportId: "export-old" }],
      postPageHasMore: false,
    })))
      .rejects.toMatchObject({
        code: "platform_post_list_empty",
        endpoint: "postList",
        ambiguous: false,
      });
  });

  it("treats a complete legacy continuation cursor as observed even with an empty snapshot", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async () => response({
        errCode: 0,
        data: { list: [], continueFlag: 0 },
      }),
    }));

    await expect(gateway.syncComments(
      fakePlatformSession(),
      JSON.stringify({
        v: 2,
        postPage: 2,
        postIndex: 0,
        commentLastBuff: "",
        postObjectId: null,
        postExportId: null,
        postSnapshot: [],
        postPageHasMore: null,
      }),
    )).rejects.toMatchObject({
      code: "platform_post_list_empty",
      endpoint: "postList",
      ambiguous: false,
    });
  });

  it.each([
    ["missing post page", {
      v: 2,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: null,
      postExportId: null,
      postSnapshot: [],
      postPageHasMore: null,
    }],
    ["invalid post page", {
      v: 2,
      postPage: 0,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: null,
      postExportId: null,
      postSnapshot: [],
      postPageHasMore: null,
    }],
    ["wrong-typed post snapshot", {
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: null,
      postExportId: null,
      postSnapshot: {},
      postPageHasMore: null,
    }],
    ["empty snapshot with active post", {
      v: 2,
      postPage: 2,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: "object-old",
      postExportId: "export-old",
      postSnapshot: [],
      postPageHasMore: null,
    }],
    ["snapshot item with empty id", {
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: "object-old",
      postExportId: "export-old",
      postSnapshot: [{ objectId: "", exportId: "export-old" }],
      postPageHasMore: false,
    }],
    ["active post does not match index", {
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "legacy-buff",
      postObjectId: "object-other",
      postExportId: "export-old",
      postSnapshot: [{ objectId: "object-old", exportId: "export-old" }],
      postPageHasMore: false,
    }],
    ["missing page continuation flag", {
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: "object-old",
      postExportId: "export-old",
      postSnapshot: [{ objectId: "object-old", exportId: "export-old" }],
    }],
    ["duplicate snapshot identity", {
      v: 2,
      postPage: 1,
      postIndex: 0,
      commentLastBuff: "",
      postObjectId: "object-old",
      postExportId: "export-old",
      postSnapshot: [
        { objectId: "object-old", exportId: "export-old" },
        { objectId: "object-old", exportId: "export-old" },
      ],
      postPageHasMore: false,
    }],
  ])("rejects a malformed legacy v2 marker: %s", async (_caseName, cursor) => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async () => {
        throw new Error("must not dispatch");
      },
    }));

    await expect(gateway.syncComments(fakePlatformSession(), JSON.stringify(cursor)))
      .rejects.toMatchObject({
        code: "schema_changed:comment.cursor",
        endpoint: "commentList",
        ambiguous: false,
      });
  });

  it("recursively normalizes nested comments with exact targets and flat write contexts", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          return response({
            errCode: 0,
            data: {
              list: [{ objectId: "object-root", exportId: "export-root" }],
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          return response({
            errCode: 0,
            data: {
              comment: [commentRecord({
                commentId: "comment-root",
                commentNickname: "根用户",
                commentContent: "根评论",
                levelTwoComment: [commentRecord({
                  commentId: "comment-child",
                  commentNickname: "子用户",
                  commentContent: "子评论",
                  levelTwoComment: [commentRecord({
                    commentId: "comment-grandchild",
                    commentNickname: "孙用户",
                    commentContent: "孙评论",
                    levelTwoComment: undefined,
                  })],
                })],
              })],
              downContinueFlag: 0,
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));

    const page = await gateway.syncComments(fakePlatformSession(), null);
    const byExternalId = new Map(page.items.map((item) => [item.externalId, item]));

    expect([...byExternalId.keys()]).toEqual([
      "object-root:comment-root",
      "object-root:comment-child",
      "object-root:comment-grandchild",
    ]);
    expect(byExternalId.get("object-root:comment-root")?.target).toMatchObject({
      kind: "comment",
      postId: "export-root",
      rootCommentId: "comment-root",
      parentCommentId: "comment-root",
    });
    expect(byExternalId.get("object-root:comment-child")?.target).toMatchObject({
      kind: "comment",
      postId: "export-root",
      rootCommentId: "comment-root",
      parentCommentId: "comment-child",
    });
    expect(byExternalId.get("object-root:comment-grandchild")?.target).toMatchObject({
      kind: "comment",
      postId: "export-root",
      rootCommentId: "comment-root",
      parentCommentId: "comment-grandchild",
    });
    for (const item of page.items) {
      if (item.target.kind !== "comment") throw new Error("expected comment target");
      expect(item.target.commentContext).toMatchObject({
        commentId: item.externalId.split(":")[1],
        commentContent: item.text,
        levelTwoComment: [],
      });
    }
  });

  it("skips a slim nested comment without failing the usable root comment", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          return response({
            errCode: 0,
            data: {
              list: [{ objectId: "object-slim", exportId: "export-slim" }],
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          return response({
            errCode: 0,
            data: {
              comment: [commentRecord({
                commentId: "comment-root",
                levelTwoComment: [{
                  commentId: "comment-slim-reply",
                  username: "peer-slim",
                  commentNickname: "Peer",
                  commentHeadurl: "",
                  commentContent: "reply text",
                  commentCreatetime: "1700000001",
                  commentLikeCount: 0,
                }],
              })],
              downContinueFlag: 0,
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));

    const page = await gateway.syncComments(fakePlatformSession(), null);

    expect(page.items.map((item) => item.externalId)).toEqual([
      "object-slim:comment-root",
    ]);
    expect(page.items.some((item) =>
      item.externalId === "object-slim:comment-slim-reply")).toBe(false);
  });

  it("keeps a replyable comment when the platform omits its username", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          return response({
            errCode: 0,
            data: {
              list: [{ objectId: "object-opaque", exportId: "export-opaque" }],
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          return response({
            errCode: 0,
            data: {
              comment: [commentRecord({
                commentId: "comment-opaque",
                username: "",
              })],
              downContinueFlag: 0,
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));

    const page = await gateway.syncComments(fakePlatformSession(), null);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.authorId).toMatch(/^comment_opaque_[a-f0-9]{64}$/);
    expect(page.items[0]?.target).toMatchObject({
      kind: "comment",
      parentCommentId: "comment-opaque",
      commentContext: { username: "" },
    });
  });

  it.each([
    ["numeric commentId", { commentId: 123 }],
    ["string commentLikeCount", { commentLikeCount: "0" }],
    ["numeric readFlag", { readFlag: 0 }],
  ])("omits an inexact comment write context without creating a reply target: %s", async (
    _caseName,
    overrides,
  ) => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          return response({
            errCode: 0,
            data: {
              list: [{ objectId: "object-strict", exportId: "export-strict" }],
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          return response({
            errCode: 0,
            data: {
              comment: [commentRecord(overrides)],
              downContinueFlag: 0,
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));

    const page = await gateway.syncComments(fakePlatformSession(), null);
    expect(page.items).toEqual([]);
  });

  it("bounds the full irreversible response and reports a timeout as ambiguous", async () => {
    const transport = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 20,
      maxResponseBytes: 10_000,
      fetchImpl: async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      }), { status: 201 }),
    });

    await expect(transport.request("dmSendText", {}, { jar: new CookieJar() }))
      .rejects.toMatchObject({
        code: "timeout",
        endpoint: "dmSendText",
        ambiguous: true,
      });
  });

  it("treats server errors and incomplete send receipts as ambiguous", async () => {
    const serverError = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({}, 500),
    });
    await expect(serverError.request("dmSendText", {}, { jar: new CookieJar() }))
      .rejects.toMatchObject({ code: "http_500", ambiguous: true });

    const missingBaseResp = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({ errCode: 0, data: { svrMsgId: "server-1" } }),
    });
    await expect(missingBaseResp.request("dmSendText", {}, { jar: new CookieJar() }))
      .rejects.toMatchObject({
        code: "schema_changed:data.baseResp",
        ambiguous: true,
      });

    const aliasOnly = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({
        errCode: 0,
        data: { baseResp: { errcode: 0 }, messageId: "unobserved-alias" },
      }),
    }));
    await expect(aliasOnly.sendReply(
      fakePlatformSession(),
      {
        kind: "dm",
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
      },
      "测试回复",
      "client-1",
    )).rejects.toMatchObject({
      code: "platform_ack_missing",
      ambiguous: true,
    });
  });

  it.each([
    {
      label: "platform rejection",
      body: { errCode: 0, data: { baseResp: { errcode: 12345 } } },
      expected: { code: "platform_12345", endpoint: "dmSendText", ambiguous: false },
    },
    {
      label: "missing receipt",
      body: { errCode: 0, data: { baseResp: { errcode: 0 } } },
      expected: { code: "platform_ack_missing", endpoint: "dmSendText", ambiguous: true },
    },
  ])("persists refreshed cookies after a DM text send $label", async ({ body, expected }) => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => new Response(JSON.stringify(body), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "send_refresh=latest; Path=/; Secure; HttpOnly",
        },
      }),
    }));
    const session = fakePlatformSession();

    await expect(gateway.sendReply(
      session,
      {
        kind: "dm",
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
      },
      "测试回复",
      "client-cookie-refresh",
    )).rejects.toMatchObject(expected);

    const persistedJar = CookieJar.deserializeSync(session.cookieJar);
    expect(persistedJar.getCookieStringSync("https://channels.weixin.qq.com/"))
      .toContain("send_refresh=latest");
  });

  it("uploads recipient-bound image chunks and sends the final opaque imgMsg", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const finalImgMsg = {
      aeskey: "platform-aes-key",
      url: "platform-media-url",
      nested: { untouched: [1, "two"] },
    };
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ path, body });
        if (path.endsWith("/upload-media-info")) {
          const chunk = Number(body.chunk);
          return response({
            errCode: 0,
            data: {
              baseResp: { errcode: 0 },
              imgMsg: chunk === 1 ? finalImgMsg : { pending: true },
            },
          });
        }
        if (path.endsWith("/send-private-msg")) {
          return response({
            errCode: 0,
            data: { baseResp: { errcode: 0 }, svrMsgId: "image-server-1" },
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    }));
    const bytes = new Uint8Array(512 * 1024 + 3).fill(0x61);
    bytes.set([0x62, 0x63, 0x64], bytes.byteLength - 3);
    let authorityChecks = 0;

    await expect(gateway.sendImageReply(
      fakePlatformSession(),
      {
        kind: "dm",
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
      },
      { mimeType: "image/png", bytes },
      "image-client-1",
      () => {
        authorityChecks += 1;
        return true;
      },
    )).resolves.toEqual({ accepted: true, externalId: "image-server-1" });

    expect(calls.map((call) => call.path)).toEqual([
      "/cgi-bin/mmfinderassistant-bin/private-msg/upload-media-info",
      "/cgi-bin/mmfinderassistant-bin/private-msg/upload-media-info",
      "/cgi-bin/mmfinderassistant-bin/private-msg/send-private-msg",
    ]);
    expect(authorityChecks).toBe(3);
    const uploadBodies = calls.slice(0, 2).map((call) => call.body);
    expect(uploadBodies.map((body) => body.chunk)).toEqual([0, 1]);
    expect(uploadBodies.every((body) => body.chunks === 2)).toBe(true);
    expect(uploadBodies.every((body) => body.fromUsername === "finder-self")).toBe(true);
    expect(uploadBodies.every((body) => body.toUsername === "peer-1")).toBe(true);
    expect(uploadBodies.every((body) => body.mediaSize === bytes.byteLength)).toBe(true);
    expect(uploadBodies.every((body) => body.mediaType === 3)).toBe(true);
    expect(uploadBodies.every((body) => body.md5 === createHash("md5").update(bytes).digest("hex")))
      .toBe(true);
    const aesKeys = new Set(uploadBodies.map((body) => String(body.aesKey)));
    expect(aesKeys.size).toBe(1);
    expect(Buffer.from([...aesKeys][0] ?? "", "base64")).toHaveLength(32);
    const decodedChunks = uploadBodies.map((body) => {
      const content = String(body.content);
      expect(content.startsWith("data:application/octet-stream;base64,")).toBe(true);
      return Buffer.from(content.slice(content.indexOf(",") + 1), "base64");
    });
    expect(Buffer.concat(decodedChunks)).toEqual(Buffer.from(bytes));
    expect(calls[2]?.body).toMatchObject({
      msgPack: {
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
        msgType: 3,
        imgMsg: finalImgMsg,
        cliMsgId: "image-client-1",
      },
    });
  });

  it("keeps image upload errors deterministic and final-send errors ambiguous", async () => {
    const uploadServerError = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({}, 500),
    });
    await expect(uploadServerError.request("dmUploadMedia", {}, { jar: new CookieJar() }))
      .rejects.toMatchObject({ endpoint: "dmUploadMedia", code: "http_500", ambiguous: false });

    let invalidUploadCalls = 0;
    const invalidUpload = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => {
        invalidUploadCalls += 1;
        return response({
          errCode: 0,
          data: { baseResp: { errcode: 0 }, imgMsg: [] },
        });
      },
    }));
    await expect(invalidUpload.sendImageReply(
      fakePlatformSession(),
      {
        kind: "dm",
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
      },
      { mimeType: "image/png", bytes: new Uint8Array([1]) },
      "image-client-invalid-upload",
    )).rejects.toMatchObject({
      endpoint: "dmUploadMedia",
      code: "schema_changed:data.imgMsg",
      ambiguous: false,
    });
    expect(invalidUploadCalls).toBe(1);

    let call = 0;
    const missingSendReceipt = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => {
        call += 1;
        return call === 1
          ? response({
              errCode: 0,
              data: { baseResp: { errcode: 0 }, imgMsg: { opaque: true } },
            })
          : response({ errCode: 0, data: { baseResp: { errcode: 0 } } });
      },
    }));
    await expect(missingSendReceipt.sendImageReply(
      fakePlatformSession(),
      {
        kind: "dm",
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
      },
      { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
      "image-client-2",
    )).rejects.toMatchObject({
      endpoint: "dmSendText",
      code: "platform_ack_missing",
      ambiguous: true,
    });
  });

  it("uses capture-backed micro request context for comment reads and writes", async () => {
    const calls: Array<{
      url: URL;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input, init) => {
        const call = {
          url: new URL(String(input)),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        calls.push(call);
        if (call.url.pathname.endsWith("/post/post_list")) {
          return response({
            errCode: 0,
            data: { list: [], continueFlag: 0 },
          });
        }
        return response({
          errCode: 0,
          data: {
            baseResp: { errcode: 0 },
            comment: { commentId: "comment-server-1" },
          },
        });
      },
    }));
    const session = fakePlatformSession();
    if (!session.requestContext) throw new Error("missing request context");
    session.requestContext.commonBody.logFinderUin = null;

    await gateway.syncComments(session, null);
    await gateway.sendReply(
      session,
      {
        kind: "comment",
        postId: "export-1",
        rootCommentId: "comment-root-1",
        parentCommentId: "comment-parent-1",
        commentContext: commentRecord({ commentId: "comment-parent-1" }),
      },
      "测试回复",
      "client-1",
    );

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list",
      "/micro/interaction/cgi-bin/mmfinderassistant-bin/comment/create_comment",
    ]);
    for (const call of calls) {
      expect([...call.url.searchParams.keys()].sort()).toEqual([
        "_aid",
        "_pageUrl",
        "_rid",
      ]);
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("x-wechat-uin")).toBe("10001");
      expect(call.headers.get("finger-print-device-id")).toBe("fingerprint-test");
      expect(call.body).toMatchObject({
        _log_finder_id: "finder-self",
        _log_finder_uin: null,
        rawKeyBuff: "",
        scene: 7,
        reqScene: 7,
        pluginSessionId: null,
      });
      expect(call.body.timestamp).toEqual(expect.any(String));
    }
    expect(calls[0]?.headers.get("referer"))
      .toBe("https://channels.weixin.qq.com/");
    expect(calls[1]?.headers.get("referer"))
      .toBe("https://channels.weixin.qq.com/micro/interaction/comment");
    expect(calls[1]?.body).toMatchObject({
      exportId: "export-1",
      rootCommentId: "comment-root-1",
      replyCommentId: "comment-parent-1",
      content: "测试回复",
      clientId: "client-1",
    });
  });

  it("fails comments closed when an old session lacks captured context", async () => {
    const session = fakePlatformSession();
    session.transportProfile = "legacy_root";
    delete session.requestContext;
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => {
        throw new Error("must not dispatch");
      },
    }));

    await expect(gateway.syncComments(session, null)).rejects.toMatchObject({
      code: "schema_changed:comment_context_missing",
      endpoint: "postList",
      ambiguous: false,
    });
  });

  it("drains DM history for the baseline and then re-reads only its first page", async () => {
    const calls: Array<{ path: string; cookie: string | null }> = [];
    let historyPage = 0;
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const form = new URLSearchParams(String(init?.body));
        calls.push({ path: url.pathname, cookie: form.get("cookie") });
        if (url.pathname.endsWith("/get-history-msg")) {
          historyPage += 1;
          return response({
            errCode: 0,
            data: {
              msg: historyPage >= 3
                ? [{
                    msgType: 1,
                    fromUsername: "peer-1",
                    toUsername: "finder-self",
                    textMsg: { content: "一条新的测试私信" },
                    svrMsgId: "new-message-1",
                    sessionId: "conversation-1",
                    createTime: "1710000000",
                  }]
                : [],
              cookie: `history-${historyPage + 1}`,
              isContinue: historyPage === 1 ? 1 : 0,
            },
          });
        }
        if (url.pathname.endsWith("/get-session-info")) {
          return response({
            errCode: 0,
            data: {
              sessionInfo: [{
                sessionId: "conversation-1",
                username: "peer-1",
                nickname: "访客",
              }],
            },
          });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    }));
    const session = fakePlatformSession();

    const first = await gateway.syncDirectMessages(session, null);
    const second = await gateway.syncDirectMessages(session, first.cursor);
    const third = await gateway.syncDirectMessages(session, second.cursor);

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(third.hasMore).toBe(false);
    // The baseline follows the platform's continuation cookie; afterwards every read is the first
    // page again, and the abandoned notify and login-cookie endpoints are never contacted.
    expect(calls.map((call) => call.path)).toEqual([
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-session-info",
    ]);
    expect(calls[1]?.cookie).toBe("history-2");
    // No continuation token on the incremental read: the first page is exactly what is wanted.
    expect(calls[2]?.cookie).toBeNull();
    expect(JSON.parse(String(second.cursor))).toEqual({ v: 2, phase: "incremental", cursor: null });
    expect(JSON.parse(String(third.cursor))).toEqual({ v: 2, phase: "incremental", cursor: null });
    expect(third.items).toEqual([expect.objectContaining({
      source: "dm",
      externalId: "new-message-1",
      authorId: "peer-1",
      authorName: "访客",
      text: "一条新的测试私信",
      target: {
        kind: "dm",
        sessionId: "conversation-1",
        fromUsername: "finder-self",
        toUsername: "peer-1",
      },
    })]);
  });

  it("keeps reading history for a retained cursor from the abandoned notify channel", async () => {
    const paths: string[] = [];
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        return response({
          errCode: 0,
          data: { msg: [], cookie: "history-next", isContinue: 0 },
        });
      },
    }));

    const legacyCursor = JSON.stringify({ v: 1, phase: "incremental", cursor: "notify-token" });
    const page = await gateway.syncDirectMessages(fakePlatformSession(), legacyCursor);

    expect(paths).toEqual(["/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg"]);
    expect(page.hasMore).toBe(false);
    expect(JSON.parse(String(page.cursor))).toEqual({ v: 2, phase: "incremental", cursor: null });
  });

  it("reports a blank DM history continuation cursor as retryable, not as a schema change", async () => {
    const blankCursorGateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({
        errCode: 0,
        data: { msg: [], cookie: "   ", isContinue: 1 },
      }),
    }));

    await expect(blankCursorGateway.syncDirectMessages(fakePlatformSession(), null))
      .rejects.toMatchObject({
        code: "dm_cursor_unavailable",
        endpoint: "dmHistory",
      });
  });

  it("keeps the DM history pagination flag required", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({
        errCode: 0,
        data: { msg: [], cookie: "history-cursor" },
      }),
    }));

    await expect(gateway.syncDirectMessages(fakePlatformSession(), null))
      .rejects.toMatchObject({
        code: "schema_changed:data.isContinue",
        endpoint: "dmHistory",
        ambiguous: false,
      });
  });

  it("rejects a malformed history pagination flag", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async () => response({
        errCode: 0,
        data: { msg: [], cookie: "history-end", isContinue: 2 },
      }),
    }));

    await expect(gateway.syncDirectMessages(fakePlatformSession(), null))
      .rejects.toMatchObject({
        code: "schema_changed:data.isContinue",
        endpoint: "dmHistory",
        ambiguous: false,
      });
  });
});

function commentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    levelTwoComment: [],
    commentId: "comment-1",
    commentNickname: "访客",
    commentContent: "测试评论",
    commentHeadurl: "",
    commentCreatetime: "1710000000",
    commentLikeCount: 0,
    lastBuff: "",
    downContinueFlag: 0,
    visibleFlag: 1,
    readFlag: false,
    displayFlag: 1,
    username: "peer-1",
    blacklistFlag: 0,
    likeFlag: 0,
    ...overrides,
  };
}

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
