import { describe, expect, it } from "vitest";
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

  it("keeps objectId distinct from exportId and uses exportId as comment reply target", async () => {
    const postBodies: Array<Record<string, unknown>> = [];
    const transport = new WechatTransport({
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
              list: [
                { objectId: "object-1", exportId: "export-9" },
                { objectId: "object-2", exportId: "export-10" },
              ],
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          return response({
            errCode: 0,
            data: {
              comment: [{
                levelTwoComment: [],
                commentId: "comment-1",
                commentNickname: "访客",
                commentContent: "价格是多少？",
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
              }],
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const gateway = new PrivateWechatGateway(transport);
    const page = await gateway.syncComments(fakePlatformSession(), null);
    const nextPage = await gateway.syncComments(fakePlatformSession(), page.cursor);

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.externalId).toBe("object-1:comment-1");
    expect(page.items[0]?.target).toMatchObject({
      kind: "comment",
      postId: "export-9",
      rootCommentId: "comment-1",
    });
    expect(nextPage.hasMore).toBe(false);
    expect(nextPage.items[0]?.externalId).toBe("object-2:comment-1");
    expect(nextPage.items[0]?.target).toMatchObject({ postId: "export-10" });
    expect(postBodies[0]?.userpageType).toBe(0);
    expect(postBodies[0]?.stickyOrder).toBe(false);
    expect(postBodies[0]).not.toHaveProperty("onlyUnread");
    expect(postBodies.every((body) => !Object.hasOwn(body, "lastBuff"))).toBe(true);
  });

  it("pages posts by currentPage without depending on a post continuation buffer", async () => {
    const postBodies: Array<Record<string, unknown>> = [];
    const commentExportIds: string[] = [];
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          postBodies.push(body);
          if (body.currentPage === 1) {
            return response({
              errCode: 0,
              data: {
                list: [{ objectId: "object-page-1", exportId: "export-page-1" }],
                continueFlag: 1,
                lastBuff: "response-buffer-must-not-be-forwarded",
              },
            });
          }
          if (body.currentPage === 2) {
            return response({
              errCode: 0,
              data: {
                list: [{ objectId: "object-page-2", exportId: "export-page-2" }],
                continueFlag: 0,
              },
            });
          }
        }
        if (url.includes("/comment/comment_list")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (typeof body.exportId !== "string") throw new Error("missing exportId");
          commentExportIds.push(body.exportId);
          return response({
            errCode: 0,
            data: { comment: [], downContinueFlag: 0 },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));
    const session = fakePlatformSession();

    const first = await gateway.syncComments(session, null);
    const second = await gateway.syncComments(session, first.cursor);

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(commentExportIds).toEqual(["export-page-1", "export-page-2"]);
    expect(postBodies.map((body) => ({
      currentPage: body.currentPage,
      pageSize: body.pageSize,
      userpageType: body.userpageType,
      stickyOrder: body.stickyOrder,
      hasLastBuff: Object.hasOwn(body, "lastBuff"),
    }))).toEqual([
      {
        currentPage: 1,
        pageSize: 20,
        userpageType: 0,
        stickyOrder: false,
        hasLastBuff: false,
      },
      {
        currentPage: 2,
        pageSize: 20,
        userpageType: 0,
        stickyOrder: false,
        hasLastBuff: false,
      },
    ]);
  });

  it("keeps a paginated comment bound to the same post when the post list reorders", async () => {
    let postRequests = 0;
    const commentRequests: Array<{ exportId: string | null; lastBuff: string | null }> = [];
    const transport = new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/post/post_list")) {
          postRequests += 1;
          const posts = [
            { objectId: "object-a", exportId: "export-a" },
            { objectId: "object-b", exportId: "export-b" },
          ];
          return response({
            errCode: 0,
            data: {
              list: postRequests === 1 ? posts : posts.toReversed(),
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const request = {
            exportId: typeof body.exportId === "string" ? body.exportId : null,
            lastBuff: typeof body.lastBuff === "string" ? body.lastBuff : null,
          };
          commentRequests.push(request);
          if (request.exportId === "export-a" && request.lastBuff === "") {
            return response({
              errCode: 0,
              data: {
                comment: [commentRecord({
                  commentId: "comment-a-1",
                  commentContent: "A 第一页",
                  lastBuff: "comment-a-next",
                  downContinueFlag: 1,
                })],
                lastBuff: "comment-a-next",
                downContinueFlag: 1,
              },
            });
          }
          if (request.exportId === "export-a" && request.lastBuff === "comment-a-next") {
            return response({
              errCode: 0,
              data: {
                comment: [commentRecord({
                  commentId: "comment-a-2",
                  commentContent: "A 第二页",
                })],
                downContinueFlag: 0,
              },
            });
          }
          if (request.exportId === "export-b" && request.lastBuff === "") {
            return response({
              errCode: 0,
              data: {
                comment: [commentRecord({
                  commentId: "comment-b-1",
                  commentContent: "B 第一页",
                })],
                downContinueFlag: 0,
              },
            });
          }
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const gateway = new PrivateWechatGateway(transport);
    const session = fakePlatformSession();

    const first = await gateway.syncComments(session, null);
    const second = await gateway.syncComments(session, first.cursor);
    const third = await gateway.syncComments(session, second.cursor);

    expect(commentRequests).toEqual([
      { exportId: "export-a", lastBuff: "" },
      { exportId: "export-a", lastBuff: "comment-a-next" },
      { exportId: "export-b", lastBuff: "" },
    ]);
    expect(first.items[0]?.externalId).toBe("object-a:comment-a-1");
    expect(second.items[0]?.externalId).toBe("object-a:comment-a-2");
    expect(third.items[0]?.externalId).toBe("object-b:comment-b-1");
    expect(third.hasMore).toBe(false);
  });

  it("fails closed when the post pinned by a comment cursor disappears", async () => {
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
              list: postRequests === 1
                ? [
                    { objectId: "object-a", exportId: "export-a" },
                    { objectId: "object-b", exportId: "export-b" },
                  ]
                : [{ objectId: "object-b", exportId: "export-b" }],
              continueFlag: 0,
            },
          });
        }
        if (url.includes("/comment/comment_list")) {
          commentRequests += 1;
          return response({
            errCode: 0,
            data: {
              comment: [commentRecord({
                commentId: "comment-a-1",
                lastBuff: "comment-a-next",
                downContinueFlag: 1,
              })],
              lastBuff: "comment-a-next",
              downContinueFlag: 1,
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    }));
    const session = fakePlatformSession();
    const first = await gateway.syncComments(session, null);

    await expect(gateway.syncComments(session, first.cursor)).rejects.toMatchObject({
      code: "schema_changed:post.cursor_target_missing",
      endpoint: "postList",
      ambiguous: false,
    });
    expect(commentRequests).toBe(1);
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
        _log_finder_uin: "",
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

  it("drains DM history and accepts an incremental page without a pagination flag", async () => {
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
              msg: [],
              cookie: `history-${historyPage + 1}`,
              isContinue: historyPage === 1 ? 1 : 0,
            },
          });
        }
        if (url.pathname.endsWith("/get-login-cookie")) {
          return response({
            errCode: 0,
            data: { baseResp: { errcode: 0 }, cookie: "incremental-1" },
          });
        }
        if (url.pathname.endsWith("/get-new-msg")) {
          return response({
            errCode: 0,
            data: {
              baseResp: { errcode: 0 },
              msg: [{
                msgType: 1,
                fromUsername: "peer-1",
                toUsername: "finder-self",
                textMsg: { content: "一条新的测试私信" },
                svrMsgId: "new-message-1",
                sessionId: "conversation-1",
                createTime: "1710000000",
              }],
              cookie: "incremental-2",
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
    expect(calls.map((call) => call.path)).toEqual([
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-history-msg",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-login-cookie",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-new-msg",
      "/cgi-bin/mmfinderassistant-bin/private-msg/get-session-info",
    ]);
    expect(calls[1]?.cookie).toBe("history-2");
    expect(calls[3]?.cookie).toBe("incremental-1");
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
    expect(session.dmCursor).toBe("incremental-2");
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

  it("rejects a malformed explicit incremental pagination flag", async () => {
    const gateway = new PrivateWechatGateway(new WechatTransport({
      baseUrl: "https://channels.weixin.qq.com",
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/get-history-msg")) {
          return response({
            errCode: 0,
            data: { msg: [], cookie: "history-end", isContinue: 0 },
          });
        }
        if (path.endsWith("/get-login-cookie")) {
          return response({
            errCode: 0,
            data: { baseResp: { errcode: 0 }, cookie: "incremental-1" },
          });
        }
        if (path.endsWith("/get-new-msg")) {
          return response({
            errCode: 0,
            data: {
              baseResp: { errcode: 0 },
              msg: [],
              cookie: "incremental-2",
              isContinue: 2,
            },
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    }));
    const session = fakePlatformSession();
    const baseline = await gateway.syncDirectMessages(session, null);

    await expect(gateway.syncDirectMessages(session, baseline.cursor))
      .rejects.toMatchObject({
        code: "schema_changed:data.isContinue",
        endpoint: "dmNewMessages",
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
