## Context

The Demo currently constructs one process-wide Ark-backed `ReplyModel`. Each reply job decrypts one inbound item, generates one text, and submits one Video Channels write. Sessions persist only the automatic-reply switch, while the page always presents `chat-llm` as the generator.

The recruitment service is reachable only from the DEV host's allowlisted source IP. It exposes two intentionally different JSON contracts: stateless comment generation at `/job/comment-reply/{job_number}` and stateful IM generation at `/agent/b2c/chat`. Comment generation may intentionally return an empty reply. IM generation may return multiple text bubbles and an action. Both paths require a pre-existing recruitment `job_number`.

Existing DEV data includes encrypted reply results shaped as `{ text, model, ... }`; the change must preserve their readability and the existing logged-in Video Channels sessions.

## Goals / Non-Goals

**Goals:**

- Persist one reply provider and recruitment job number per logged-in Video Channels account.
- Route comment and direct-message inputs to the matching recruitment endpoint when selected.
- Preserve raw inbound text, stable external idempotency keys, intentional no-reply results, and ordered multi-bubble sends.
- Keep upstream access server-side and observable without exposing host details, model names, message bodies, or credentials in the page or logs.
- Deploy independently to DEV without changing AIDCP or isales services.

**Non-Goals:**

- Creating recruitment jobs or mapping multiple Video Channels posts to different jobs.
- Sending a WeChat QR image, executing human handoff, or adding non-text Video Channels messages.
- Sharing conversation history between CHAT and recruitment providers.
- Adding automatic retries, provider fallback, streaming responses, or browser-side calls to the recruitment service.

## Decisions

### Persist provider configuration on each Demo session

`demo_sessions` gains `reply_provider` with values `chat-llm|funnel` and nullable `funnel_job_number`. Existing rows migrate to `chat-llm`. The session snapshot and shared-session summary expose the selected provider but never the concrete Ark model identifier or upstream base URL.

The same provider governs comments and direct messages for that account. This matches the requested single switch while the adapter still selects the source-specific endpoint. A future post-to-job mapping can replace the one-job-per-account assumption without changing the provider choice.

Alternative considered: process-wide environment switch. Rejected because the Demo supports multiple logged-in accounts and an operator must be able to compare providers without restarting the service.

### Save the job number with the provider setting

`POST /api/session/reply-provider` accepts `{ provider, jobNumber }`. Selecting `funnel` requires a non-empty bounded job number and a configured upstream base URL. The field is editable in the page and saved per account. Selecting `chat-llm` retains the last job number so switching back does not require re-entry.

Alternative considered: one global `FUNNEL_JOB_NUMBER`. Rejected because it would silently apply one vacancy to every logged-in account and makes later multi-account demos misleading.

### Use a provider registry with no fallback

The worker receives both provider adapters and chooses one from the current session row when it begins generation. Provider switches affect subsequently claimed jobs; a job already generating finishes with the provider and job number captured at its start. A failure is recorded against that provider and never calls the other provider.

The existing result remains backward-compatible by retaining `text` for display and adding optional `messages` plus `disposition`. Existing encrypted `{text}` results continue to render and send as one message.

### Keep recruitment traffic on the backend

`FUNNEL_BASE_URL` and `FUNNEL_TIMEOUT_MS` configure a bounded JSON client. The browser only calls the Demo's same-origin settings API. This preserves the DEV source IP required by the upstream allowlist and avoids HTTPS mixed-content and CORS failures.

The client records only the upstream `X-Request-Id` as provider evidence. It applies the existing response-size limit and maps status, timeout, malformed JSON, and contract failures to stable error codes without logging request or response bodies.

### Route by inbound source

For comments, the adapter posts the unmodified inbound text as `{ comment }` to `/job/comment-reply/{encodedJobNumber}`. A successful empty `reply` becomes `disposition=skip`; the reply job transitions to terminal `skipped` without a Video Channels write.

For direct messages, the adapter posts to `/agent/b2c/chat` with a stable opaque `session_id`, raw `user_input`, the configured `job_number`, `scenario="im"`, `platform="视频号"`, and a stable opaque `msg_id`. The opaque IDs are keyed hashes derived from the Demo account/session, normalized job number, and the Video Channels conversation/message identifiers. Retries stay stable without disclosing raw platform IDs, while changing the job number starts a new upstream conversation instead of reusing a context that is sticky to the old job.

The Demo sends each non-empty `content_list` element as a separate text message in order. The first message reuses the reply job's persisted platform client ID; later messages use deterministic suffixes.

### Preserve honest multi-message outcomes

Before the first platform dispatch, any generation or contract error is `failed`. If no messages are returned, the job is `skipped`. Once one bubble has been submitted, a later explicit failure or ambiguous result makes the group `submitted_unknown`; the job is never replayed automatically. A fully successful group stores one keyed hash over the ordered platform receipts and becomes `confirmed`.

The worker checks the existing send authorization before every bubble. Stopping automation between bubbles prevents another dispatch but cannot retract bubbles already submitted.

### Refuse unsupported recruitment actions before sending text

If the recruitment response contains `send_wechat_qr`, `escalate_to_human`, or any unknown action, generation fails before any Video Channels text is sent. This prevents sending text that promises an unexecuted QR or handoff. Adding those actions requires a separate media/handoff capability and its own acceptance evidence.

## Risks / Trade-offs

- [One job number is shared by every post under an account] → The UI labels it as the account's recruitment job number; multi-post mapping remains a documented non-goal.
- [The recruitment service is an HTTP endpoint] → Only the allowlisted DEV backend calls it; no secrets are sent and the browser never receives its address.
- [Switching providers loses conversational continuity] → The page describes the switch as applying to new replies and the adapters never pretend to share history.
- [Multiple bubbles can partially succeed] → Sequential dispatch plus `submitted_unknown` prevents automatic duplicate replay after any dispatch.
- [The upstream frequently requests a QR action] → Fail before text dispatch until the Demo has a real QR media-send implementation and configured asset.
- [Private external contracts may drift] → Validate response shapes strictly and surface stable failures instead of guessing or falling back.

## Migration Plan

1. Add nullable/defaulted SQLite columns in the existing startup migration; do not delete or rewrite sessions, credentials, inbound items, or encrypted reply outputs.
2. Validate the feature in an isolated worktree with adapter, migration, integration, UI-copy, lint, typecheck, build, and strict OpenSpec checks.
3. Integrate the committed change into the clean standalone `main` branch.
4. On DEV, back up the current release pointer, environment file, systemd unit, and SQLite data; add only the upstream base URL/timeout to the root-owned environment file.
5. Install the committed release with the Alibaba Cloud npm mirror, switch `current`, and restart only `wechat-channels-ai-demo.service`.
6. Verify database migration, service/HTTPS health, upstream health from DEV, retained logged-in sessions, provider switching, and source-specific requests. Real Video Channels writes remain separately observable.

Rollback restores the previous release and SQLite backup, then restarts the same Demo unit. The extra columns are backward-compatible with the previous binary, but the database backup remains the authoritative rollback artifact.

At startup, retained sessions whose selected provider is no longer configured have automation disabled before workers start. Any still-queued replies under the superseded run generation are terminally failed in the same transaction, so they cannot remain permanently unclaimable. This keeps a changed or rolled-back environment from repeatedly claiming jobs that cannot be generated.

## Open Questions

- The operator must supply an existing `job_number` through the page before the recruitment provider can generate replies.
- QR media delivery and human handoff require separate product input and platform capability work.
