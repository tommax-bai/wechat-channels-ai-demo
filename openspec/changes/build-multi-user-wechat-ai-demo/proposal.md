## Why

Prospective customers need a small, self-contained demonstration of browserless WeChat Channels login and AI-assisted interaction handling without depending on the existing AIDCP Edge, Cloud, Console, approval, risk, or orchestration stacks. The demo must let multiple visitors independently authorize an account, observe inbound direct messages and comments, and automatically reply with the configured Doubao character model.

## What Changes

- Create a new standalone repository and single deployable web service with no runtime dependency on any AIDCP repository or database.
- Add multi-user, pure-HTTP QR login for WeChat Channels with isolated encrypted server-side sessions.
- Add polling and normalization for inbound direct messages and comments from the authorized account.
- Show historical content without replying to it, establish a per-login baseline, and automatically reply only to new inbound content observed after that baseline.
- Generate replies with `doubao-seed-character-260628` through a separately configured model provider.
- Send text replies directly through the corresponding private WeChat Channels endpoints and record only platform-confirmed outcomes as successful.
- Add a customer-facing demo page that shows QR/login state, account state, inbound items, generated replies, delivery outcomes, and a stop/logout control.
- Add bounded retention, tenant isolation, encrypted credential and customer-content storage, idempotency, and a service-wide emergency stop as correctness protections; do not import AIDCP business strategies.

## Capabilities

### New Capabilities

- `multi-user-qr-auth`: Isolated browserless QR authorization, encrypted session persistence, expiry, logout, and tenant-safe status access.
- `wechat-inbound-sync`: Baseline and incremental retrieval of WeChat Channels direct messages and comments with normalized records and durable deduplication.
- `ai-auto-reply`: Doubao reply generation and exact-target private-message/comment delivery for newly observed inbound items.
- `demo-operations-ui`: Customer-facing QR, connection, content timeline, reply outcome, stop, and logout experience with real-time updates.

### Modified Capabilities

None.

## Impact

- New standalone repository: `wechat-channels-ai-demo`.
- New TypeScript service, web application, SQLite state store, test suite, and local deployment configuration.
- External dependencies: private undocumented `channels.weixin.qq.com` endpoints and the configured Volcengine/Doubao model endpoint.
- The service will temporarily hold real customer WeChat Channels session credentials and interaction content; credentials and content remain server-side, are encrypted at rest, are never exposed across tenants, and are removed on logout or retention expiry.
- No existing AIDCP source, database schema, runtime service, deployment, or product behavior is modified.
