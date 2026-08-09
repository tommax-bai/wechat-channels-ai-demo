## Context

The Demo currently models generated replies as text bubbles and the Video Channels gateway only sends `msgType: 1` private messages. Funnel's private-message contract can return `action: "send_wechat_qr"` without carrying an image URL or image bytes, so the caller must own the QR asset and send it in the same turn.

The current Video Channels web bundle provides a bounded image path: convert each image chunk to a data URL, POST 512 KiB chunks to `/private-msg/upload-media-info`, retain the final platform-returned `imgMsg`, then POST that opaque object to `/private-msg/send-private-msg` with `msgType: 3`. The final send remains confirmed only when `svrMsgId` is present.

## Goals / Non-Goals

**Goals:**

- Store one business QR image per hosted Video Channels account and allow both the Demo UI and Partner API to manage it.
- Support Funnel's `send_wechat_qr` action for private messages while preserving ordered text bubbles and honest platform outcomes.
- Reuse the existing account, encryption, worker authority, credential persistence, and reply receipt paths.
- Keep the media protocol isolated behind the existing Video Channels gateway.

**Non-Goals:**

- Reuse or expose the Video Channels login QR as a business QR.
- Accept a QR image URL or fetch arbitrary remote content.
- Display inbound image messages or call `/private-msg/get-media-info`.
- Send images in comments, CHAT replies, or unsupported Funnel actions.
- Cache one uploaded `imgMsg` across recipients; uploads are recipient-bound.

## Decisions

### Store a bounded encrypted asset per account

Add an `account_qr_assets` table keyed by `session_id`, with the existing secure-store envelope plus non-sensitive MIME, byte-length, and update-time metadata. The encrypted value contains the validated MIME and Base64 bytes. Deleting a session cascades to its QR asset.

Only PNG and JPEG magic bytes are accepted, decoded content must be non-empty and at most 512 KiB, and input is a `data:image/...;base64,...` value. This avoids filesystem/release coupling and remote-fetch/SSRF behavior while remaining sufficient for QR artwork. Browser and Partner APIs expose configuration metadata; only the selected Demo account's same-origin preview endpoint returns the data URL.

Alternative considered: storing a path under the release data directory. This adds backup, stale-file, and atomic replacement concerns without a benefit for a single small asset per account.

### Represent Funnel action explicitly in the encrypted reply output

Extend `ReplyModelResult` with optional `action: "send_wechat_qr"`. The Funnel parser accepts that action only for the direct-message response shape, preserves all `content_list` bubbles, and continues to reject `escalate_to_human` and unknown actions before any platform dispatch.

An action counts as a reply even if the text list is empty. Before marking the reply ready to dispatch, the worker loads and decrypts the current account asset. If it is absent or invalid, the job fails as `account_wechat_qr_not_configured` or `account_wechat_qr_invalid` before sending Funnel text that promises an image.

Alternative considered: translate the action into a synthetic text message. That would not satisfy Funnel's image-message contract and would reproduce the current visible failure in a different form.

### Upload for the current recipient, then send the opaque image descriptor

For each action, the gateway:

1. Splits the configured bytes into 512 KiB chunks.
2. Generates an opaque random AES-key value and computes the actual MD5 of the complete bytes.
3. Calls `upload-media-info` for every chunk with `mediaType: 3`, the current account and recipient usernames, total size, chunk indexes, and data-URL content.
4. Requires a successful platform envelope and retains the final non-array `data.imgMsg` object without reconstructing its fields.
5. Calls `send-private-msg` using the existing session target, `msgType: 3`, that `imgMsg`, and a distinct deterministic client ID.
6. Requires `data.svrMsgId` and includes it in the reply job's existing receipt hash.

The worker sends text bubbles in order and the image last. It binds the action to the encrypted asset revision loaded during generation, then rechecks both send authority and that asset revision before every text request, upload chunk, and final image send. A replacement or deletion therefore stops the stale turn before its next write. The worker does not automatically retry upload or final send. A failure after any prior text receipt, or an ambiguous final request, records `submitted_unknown`; a deterministic failure before any recipient-visible send records `failed`.

Alternative considered: upload once and reuse `imgMsg` for every conversation. The upload request is recipient-bound through `toUsername`, and no current evidence proves cross-recipient reuse is valid.

### Keep API projections asset-light

Account/session projections add QR configuration metadata rather than image bytes. Management endpoints are:

- Demo: `GET`, `PUT`, and `DELETE /api/session/wechat-qr`.
- Partner: `GET`, `PUT`, and `DELETE /partner/v1/accounts/{accountId}/wechat-qr`.

`PUT` accepts strict JSON `{ "dataUrl": "..." }`; `GET` returns configured state, MIME, byte length, and update time. The Demo GET additionally returns the selected account's preview data URL. Every Demo QR request carries the page's current account ID and the response echoes it, so another tab changing the shared selected-account cookie cannot redirect an in-flight preview, replacement, or deletion. Partner account projections include the same metadata but never the bytes.

## Risks / Trade-offs

- [Private Video Channels endpoints can drift] → Keep exact request descriptors and focused contract tests; surface schema/platform errors without fallback guessing.
- [Text can succeed before image upload/send fails] → Record `submitted_unknown`, retain the exact error code, and never report the whole turn confirmed.
- [The QR changes while a turn is sending] → Revalidate the bound encrypted asset revision before every platform write; stop stale delivery and preserve any already-confirmed partial outcome.
- [Worker restart during a multi-part turn loses exact stage] → Existing interrupted-send recovery remains terminal/unknown; no blind retry of recipient-visible writes.
- [A 512 KiB limit rejects unusually large artwork] → Show the limit in UI/API errors; QR images can be exported below this bound without server-side image libraries.
- [Configured QR is sensitive business contact data] → Encrypt at rest and omit bytes from lists, timelines, logs, and Partner account projections.

## Migration Plan

1. Add the idempotent SQLite table migration; existing accounts begin with no QR configured.
2. Deploy code and static assets together, restart only `wechat-channels-ai-demo.service`, and verify health/readiness and existing account projections.
3. Configure a disposable account QR and validate upload metadata without sending.
4. With an explicitly selected disposable private-message target, trigger one Funnel action and verify ordered text receipts plus the image `svrMsgId`.
5. Rollback code if needed; the additive table is ignored by the previous release and can remain for a later retry.

## Open Questions

None. Live recipient-visible validation requires a separately authorized disposable conversation and is not implied by deployment.
