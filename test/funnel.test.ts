import { describe, expect, it, vi } from "vitest";
import { FunnelReplyModel } from "../src/model/funnel.js";

const commentInput = {
  source: "comment" as const,
  authorName: "访客",
  text: "  一个月能挣多少啊  ",
  jobNumber: "job/合肥 01",
  conversationId: "unused-conversation",
  messageId: "unused-message",
};

const dmInput = {
  source: "dm" as const,
  authorName: "访客",
  text: "多少钱",
  jobNumber: "job-001",
  conversationId: "opaque-session-1",
  messageId: "opaque-message-1",
};

function createModel(fetchImpl: typeof fetch, maxResponseBytes?: number): FunnelReplyModel {
  return new FunnelReplyModel({
    baseUrl: "http://funnel.example.test:9093/",
    timeoutMs: 1_000,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    fetchImpl,
  });
}

describe("FunnelReplyModel", () => {
  it("routes comments to the encoded job endpoint with the unmodified text", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "http://funnel.example.test:9093/job/comment-reply/job%2F%E5%90%88%E8%82%A5%2001",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        Accept: "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ comment: commentInput.text });
      return new Response(JSON.stringify({
        success: true,
        job_number: commentInput.jobNumber,
        reply: "8000-12000元/月",
      }), { headers: { "X-Request-Id": "comment-request-1" } });
    }) as typeof fetch;

    await expect(createModel(fetchImpl).generate(commentInput)).resolves.toEqual({
      text: "8000-12000元/月",
      messages: ["8000-12000元/月"],
      disposition: "reply",
      model: "funnel",
      requestId: "comment-request-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("turns an empty comment reply into an intentional skip", async () => {
    const model = createModel(async () => new Response(JSON.stringify({
      success: true,
      job_number: commentInput.jobNumber,
      reply: "",
    }), {
      headers: { "x-request-id": "comment-request-2" },
    }));

    await expect(model.generate(commentInput)).resolves.toEqual({
      text: "",
      messages: [],
      disposition: "skip",
      model: "funnel",
      requestId: "comment-request-2",
    });
  });

  it("fails closed when the comment response belongs to another job", async () => {
    const model = createModel(async () => new Response(JSON.stringify({
      success: true,
      job_number: "another-job",
      reply: "错误岗位回复",
    })));

    await expect(model.generate(commentInput)).rejects.toMatchObject({
      code: "funnel_invalid_comment_response",
    });
  });

  it("routes direct messages with the complete IM contract and preserves bubble order", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://funnel.example.test:9093/agent/b2c/chat");
      expect(JSON.parse(String(init?.body))).toEqual({
        session_id: "opaque-session-1",
        user_input: "多少钱",
        job_number: "job-001",
        scenario: "im",
        platform: "视频号",
        msg_id: "opaque-message-1",
      });
      return new Response(JSON.stringify({
        content_list: [
          "薪资8000-12000一个月",
          "具体情况可以继续聊",
        ],
        agent_type: "b2c",
        scenario: "im",
      }), { headers: { "X-Request-Id": "dm-request-1" } });
    }) as typeof fetch;

    await expect(createModel(fetchImpl).generate(dmInput)).resolves.toEqual({
      text: "薪资8000-12000一个月\n具体情况可以继续聊",
      messages: ["薪资8000-12000一个月", "具体情况可以继续聊"],
      disposition: "reply",
      model: "funnel",
      requestId: "dm-request-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves direct-message bubbles and accepts the QR action", async () => {
    const model = createModel(async () => new Response(JSON.stringify({
      content_list: ["第一条", "  第二条  "],
      agent_type: "b2c",
      scenario: "im",
      action: "send_wechat_qr",
    })));

    await expect(model.generate(dmInput)).resolves.toMatchObject({
      text: "第一条\n第二条",
      messages: ["第一条", "第二条"],
      disposition: "reply",
      action: "send_wechat_qr",
      model: "funnel",
    });
  });

  it("keeps an action-only direct-message response replyable", async () => {
    const model = createModel(async () => new Response(JSON.stringify({
      content_list: [],
      agent_type: "b2c",
      scenario: "im",
      action: " send_wechat_qr ",
    })));

    await expect(model.generate(dmInput)).resolves.toMatchObject({
      text: "",
      messages: [],
      disposition: "reply",
      action: "send_wechat_qr",
    });
  });

  it.each(["escalate_to_human", "future action!"])(
    "rejects unsupported action %s before returning any text",
    async (action) => {
      const model = createModel(async () => new Response(JSON.stringify({
        content_list: ["我马上处理"],
        agent_type: "b2c",
        scenario: "im",
        action,
      })));

      await expect(model.generate(dmInput)).rejects.toMatchObject({
        code: "funnel_action_unsupported",
      });
    },
  );

  it("rejects an action on an otherwise invalid direct-message response", async () => {
    const model = createModel(async () => new Response(JSON.stringify({
      content_list: [],
      agent_type: "unexpected",
      scenario: "im",
      action: "send_wechat_qr",
    })));

    await expect(model.generate(dmInput)).rejects.toMatchObject({
      code: "funnel_invalid_dm_response",
    });
  });

  it("fails closed on HTTP errors without retrying", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ detail: "session busy" }),
      { status: 409, headers: { "X-Request-Id": "failed-request-1" } },
    )) as typeof fetch;

    await expect(createModel(fetchImpl).generate(dmInput)).rejects.toMatchObject({
      code: "funnel_http_409",
      requestId: "failed-request-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies a hard deadline even when the transport ignores abort", async () => {
    const model = new FunnelReplyModel({
      baseUrl: "http://funnel.example.test:9093",
      timeoutMs: 20,
      fetchImpl: async () => new Promise<Response>(() => undefined),
    });

    await expect(model.generate(dmInput)).rejects.toMatchObject({ code: "funnel_timeout" });
  });

  it("bounds the response body by declared and streamed byte size", async () => {
    const declared = createModel(
      async () => new Response("{}", { headers: { "content-length": "17" } }),
      16,
    );
    await expect(declared.generate(commentInput)).rejects.toMatchObject({
      code: "funnel_response_too_large",
    });

    const streamed = createModel(
      async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(17)));
          controller.close();
        },
      })),
      16,
    );
    await expect(streamed.generate(commentInput)).rejects.toMatchObject({
      code: "funnel_response_too_large",
    });
  });

  it("rejects malformed JSON and invalid source-specific response fields", async () => {
    const invalidJson = createModel(async () => new Response("not-json"));
    await expect(invalidJson.generate(commentInput)).rejects.toMatchObject({
      code: "funnel_invalid_json",
    });

    const invalidComment = createModel(
      async () => new Response(JSON.stringify({
        success: true,
        job_number: commentInput.jobNumber,
        reply: 123,
      })),
    );
    await expect(invalidComment.generate(commentInput)).rejects.toMatchObject({
      code: "funnel_invalid_comment_response",
    });

    const invalidDm = createModel(
      async () => new Response(JSON.stringify({ content_list: ["ok", 123] })),
    );
    await expect(invalidDm.generate(dmInput)).rejects.toMatchObject({
      code: "funnel_invalid_dm_response",
    });

    const emptyDm = createModel(
      async () => new Response(JSON.stringify({
        content_list: ["  ", ""],
        agent_type: "b2c",
        scenario: "im",
      })),
    );
    await expect(emptyDm.generate(dmInput)).resolves.toMatchObject({
      text: "",
      messages: [],
      disposition: "skip",
    });

    const mixedDm = createModel(
      async () => new Response(JSON.stringify({
        content_list: ["第一条", "   ", "第二条"],
        agent_type: "b2c",
        scenario: "im",
      })),
    );
    await expect(mixedDm.generate(dmInput)).resolves.toMatchObject({
      text: "第一条\n第二条",
      messages: ["第一条", "第二条"],
      disposition: "reply",
    });
  });
});
