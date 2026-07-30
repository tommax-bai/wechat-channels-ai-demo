import type { ReplyModelInput, ReplyModelResult } from "../types.js";
import { ModelError, type ReplyModel } from "./reply-model.js";

export interface ArkReplyModelOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export class ArkReplyModel implements ReplyModel {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: ArkReplyModelOptions) {
    if (!options.apiKey.trim()) throw new ModelError("ark_api_key_missing");
    if (!options.model.trim()) throw new ModelError("ark_model_missing");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async generate(input: ReplyModelInput): Promise<ReplyModelResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            {
              role: "system",
              content:
                "你是视频号账号的友好客服。直接回复用户当前的问题，语气自然、简洁、有帮助；不要声称做过未发生的事情，不索取密码、验证码或敏感信息；只输出将要发送给用户的纯文本。",
            },
            {
              role: "user",
              content: [
                `渠道：${input.source === "dm" ? "私信" : "评论"}`,
                `用户称呼：${bounded(input.authorName, 80) || "用户"}`,
                `用户内容：${bounded(input.text, 2_000)}`,
              ].join("\n"),
            },
          ],
          temperature: 0.7,
          max_tokens: 512,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });

      const requestId =
        response.headers.get("x-tt-logid")
        ?? response.headers.get("x-request-id")
        ?? undefined;
      if (!response.ok) {
        throw new ModelError(`ark_http_${response.status}`);
      }
      const raw = await readBounded(
        response,
        this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
      let data: ArkResponse;
      try {
        data = JSON.parse(raw) as ArkResponse;
      } catch {
        throw new ModelError("ark_invalid_json");
      }
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== "stop") {
        throw new ModelError(
          typeof choice?.finish_reason === "string"
            ? `ark_finish_${safeReason(choice.finish_reason)}`
            : "ark_finish_reason_missing",
        );
      }
      const rawText = choice.message?.content;
      const text = typeof rawText === "string" ? bounded(rawText.trim(), 500) : "";
      if (!text) throw new ModelError("ark_missing_reply_content");
      return {
        text,
        model: typeof data.model === "string" && data.model ? data.model : this.options.model,
        ...(requestId ? { requestId } : {}),
        ...(data.usage ? {
          usage: {
            ...(typeof data.usage.prompt_tokens === "number"
              ? { promptTokens: data.usage.prompt_tokens }
              : {}),
            ...(typeof data.usage.completion_tokens === "number"
              ? { completionTokens: data.usage.completion_tokens }
              : {}),
            ...(typeof data.usage.total_tokens === "number"
              ? { totalTokens: data.usage.total_tokens }
              : {}),
          },
        } : {}),
      };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ModelError("ark_timeout");
      }
      throw new ModelError(response ? "ark_response_read_error" : "ark_network_error");
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ArkResponse {
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ModelError("ark_response_too_large");
  }
  if (!response.body) throw new ModelError("ark_invalid_json");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ModelError("ark_response_too_large");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bounded(value: string, maxCodePoints: number): string {
  return [...value].slice(0, maxCodePoints).join("");
}

function safeReason(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "unknown";
}
