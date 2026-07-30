import { describe, expect, it, vi } from "vitest";
import { ArkReplyModel } from "../src/model/ark.js";

describe("ArkReplyModel", () => {
  it("uses the exact configured model and extracts a bounded reply", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("doubao-seed-character-260628");
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      return new Response(JSON.stringify({
        model: "doubao-seed-character-260628",
        choices: [{
          finish_reason: "stop",
          message: { content: "您好，请问需要了解什么？" },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
      }), { status: 200, headers: { "x-tt-logid": "request-1" } });
    }) as typeof fetch;
    const model = new ArkReplyModel({
      apiKey: "secret",
      baseUrl: "https://ark.example.test/api/v3",
      model: "doubao-seed-character-260628",
      timeoutMs: 1_000,
      fetchImpl,
    });

    await expect(model.generate({
      source: "dm",
      authorName: "访客",
      text: "你好",
    })).resolves.toMatchObject({
      text: "您好，请问需要了解什么？",
      model: "doubao-seed-character-260628",
      requestId: "request-1",
    });
  });

  it("does not treat HTTP or empty-content responses as success", async () => {
    const denied = new ArkReplyModel({
      apiKey: "secret",
      baseUrl: "https://ark.example.test/api/v3",
      model: "doubao-seed-character-260628",
      timeoutMs: 1_000,
      fetchImpl: async () => new Response("{}", { status: 403 }),
    });
    await expect(denied.generate({ source: "comment", authorName: "访客", text: "问题" }))
      .rejects.toMatchObject({ code: "ark_http_403" });

    const empty = new ArkReplyModel({
      apiKey: "secret",
      baseUrl: "https://ark.example.test/api/v3",
      model: "doubao-seed-character-260628",
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: {} }],
      }), { status: 200 }),
    });
    await expect(empty.generate({ source: "dm", authorName: "访客", text: "问题" }))
      .rejects.toMatchObject({ code: "ark_missing_reply_content" });
  });

  it("rejects incomplete output instead of sending truncated model text", async () => {
    const model = new ArkReplyModel({
      apiKey: "secret",
      baseUrl: "https://ark.example.test/api/v3",
      model: "doubao-seed-character-260628",
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: { content: "这是一段被截断的回复" },
        }],
      }), { status: 200 }),
    });

    await expect(model.generate({ source: "dm", authorName: "访客", text: "问题" }))
      .rejects.toMatchObject({ code: "ark_finish_length" });
  });

  it("applies the timeout and size bound while reading the response body", async () => {
    const hanging = new ArkReplyModel({
      apiKey: "secret",
      baseUrl: "https://ark.example.test/api/v3",
      model: "doubao-seed-character-260628",
      timeoutMs: 20,
      fetchImpl: async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      }), { status: 200 }),
    });
    await expect(hanging.generate({ source: "dm", authorName: "访客", text: "问题" }))
      .rejects.toMatchObject({ code: "ark_timeout" });

    const oversized = new ArkReplyModel({
      apiKey: "secret",
      baseUrl: "https://ark.example.test/api/v3",
      model: "doubao-seed-character-260628",
      timeoutMs: 1_000,
      maxResponseBytes: 16,
      fetchImpl: async () => new Response("x".repeat(17), { status: 200 }),
    });
    await expect(oversized.generate({ source: "comment", authorName: "访客", text: "问题" }))
      .rejects.toMatchObject({ code: "ark_response_too_large" });
  });
});
