import type { ReplyModelInput, ReplyModelResult } from "../types.js";
import { ModelError, type ReplyModel } from "./reply-model.js";

export interface FunnelReplyModelOptions {
  baseUrl: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export class FunnelReplyModel implements ReplyModel {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FunnelReplyModelOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new ModelError("funnel_base_url_missing");
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new ModelError("funnel_timeout_invalid");
    }
    if (
      options.maxResponseBytes !== undefined
      && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
    ) {
      throw new ModelError("funnel_response_limit_invalid");
    }
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async generate(input: ReplyModelInput): Promise<ReplyModelResult> {
    const jobNumber = required(input.jobNumber, "funnel_job_number_missing");
    if (input.source === "comment") {
      return this.request(
        `/job/comment-reply/${encodeURIComponent(jobNumber)}`,
        { comment: input.text },
        (data, requestId) => parseCommentResponse(data, requestId, jobNumber),
      );
    }

    const conversationId = required(
      input.conversationId,
      "funnel_conversation_id_missing",
    );
    const messageId = required(input.messageId, "funnel_message_id_missing");
    return this.request(
      "/agent/b2c/chat",
      {
        session_id: conversationId,
        user_input: input.text,
        job_number: jobNumber,
        scenario: "im",
        platform: "视频号",
        msg_id: messageId,
      },
      parseDirectMessageResponse,
    );
  }

  private async request(
    path: string,
    body: Record<string, string>,
    parse: (data: unknown, requestId: string | undefined) => ReplyModelResult,
  ): Promise<ReplyModelResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ModelError("funnel_timeout"));
      }, this.options.timeoutMs);
    });
    let response: Response | undefined;
    try {
      response = await Promise.race([
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        deadline,
      ]);

      const requestId = boundedRequestId(response.headers.get("x-request-id"));
      if (!response.ok) {
        throw new ModelError(`funnel_http_${response.status}`, requestId);
      }

      const raw = await Promise.race([
        readBounded(
          response,
          this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        ),
        deadline,
      ]);
      let data: unknown;
      try {
        data = JSON.parse(raw) as unknown;
      } catch {
        throw new ModelError("funnel_invalid_json", requestId);
      }
      return parse(data, requestId);
    } catch (error) {
      if (error instanceof ModelError) {
        const requestId = error.requestId
          ?? boundedRequestId(response?.headers.get("x-request-id") ?? null);
        if (requestId && !error.requestId) throw new ModelError(error.code, requestId);
        throw error;
      }
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ModelError("funnel_timeout");
      }
      throw new ModelError(response ? "funnel_response_read_error" : "funnel_network_error");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function parseCommentResponse(
  data: unknown,
  requestId: string | undefined,
  expectedJobNumber: string,
): ReplyModelResult {
  if (
    !isRecord(data)
    || data.success !== true
    || typeof data.job_number !== "string"
    || data.job_number !== expectedJobNumber
    || typeof data.reply !== "string"
  ) {
    throw new ModelError("funnel_invalid_comment_response");
  }
  const text = data.reply.trim();
  return {
    text,
    messages: text ? [text] : [],
    disposition: text ? "reply" : "skip",
    model: "funnel",
    ...(requestId ? { requestId } : {}),
  };
}

function parseDirectMessageResponse(
  data: unknown,
  requestId: string | undefined,
): ReplyModelResult {
  if (
    !isRecord(data)
    || data.agent_type !== "b2c"
    || data.scenario !== "im"
    || !Array.isArray(data.content_list)
  ) {
    throw new ModelError("funnel_invalid_dm_response");
  }
  if (data.content_list.some((item) => typeof item !== "string")) {
    throw new ModelError("funnel_invalid_dm_response");
  }
  const messages = (data.content_list as string[])
    .map((item) => item.trim())
    .filter(Boolean);
  const action = parseDirectMessageAction(data.action);
  return {
    text: messages.join("\n"),
    messages,
    disposition: messages.length > 0 || action ? "reply" : "skip",
    ...(action ? { action } : {}),
    model: "funnel",
    ...(requestId ? { requestId } : {}),
  };
}

function parseDirectMessageAction(value: unknown): "send_wechat_qr" | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ModelError("funnel_invalid_dm_response");
  }
  const action = value.trim();
  if (!action) return undefined;
  if (action === "send_wechat_qr") return action;
  throw new ModelError("funnel_action_unsupported");
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ModelError("funnel_response_too_large");
  }
  if (!response.body) throw new ModelError("funnel_invalid_json");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is authoritative even if the transport cannot cancel cleanly.
      }
      throw new ModelError("funnel_response_too_large");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function required(value: string | undefined, errorCode: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new ModelError(errorCode);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedRequestId(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}
