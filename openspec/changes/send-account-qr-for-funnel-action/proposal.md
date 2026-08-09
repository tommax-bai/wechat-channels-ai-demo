## Why

Funnel direct-message responses can require `send_wechat_qr`, but the Demo currently rejects that action before sending any response. Each hosted Video Channels account needs its own configured business QR image so the promised text bubbles and matching QR image can be delivered in the same reply turn.

## What Changes

- Let the Demo page and Partner API configure, replace, inspect, and remove one bounded PNG or JPEG business QR image per hosted account.
- Persist the account QR image encrypted with the existing Demo secure store and expose configuration state without exposing another account's asset.
- Parse Funnel `send_wechat_qr` as a supported direct-message action while continuing to reject unknown actions and `escalate_to_human`.
- Send Funnel text bubbles in order, then upload and send the current account's QR image through the Video Channels private-message media protocol.
- Preserve honest send outcomes: a missing account QR fails before platform dispatch, and an ambiguous upload or send is not retried or reported as confirmed.
- Keep comments and CHAT replies text-only; the action applies only to Funnel direct messages.

## Capabilities

### New Capabilities

- `account-qr-action-reply`: Per-account business QR configuration and Video Channels image delivery for Funnel direct-message actions.

### Modified Capabilities

None.

## Impact

- Demo account settings UI and browser API.
- Partner integration API and its Markdown/OpenAPI documentation.
- SQLite session schema, encrypted account settings, reply-job action output, and public projections.
- Funnel response parsing, reply orchestration, and the private-message gateway/transport.
- Current private Video Channels endpoints `/private-msg/upload-media-info` and `/private-msg/send-private-msg`; no AIDCP or unrelated DEV service is changed.
