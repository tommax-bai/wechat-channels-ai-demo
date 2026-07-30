## Why

Prospective customers need a small, self-contained public demonstration of WeChat Channels QR login and AI-assisted interaction handling without depending on the existing AIDCP Edge, Cloud, Console, approval, risk, or orchestration stacks. The demo must let multiple accounts remain logged in at once, let every visitor see and switch among those demo accounts, observe inbound direct messages and comments, and automatically reply with the configured server-side model.

## What Changes

- Create a new standalone repository and single deployable web service with no runtime dependency on any AIDCP repository or database.
- Add multi-account QR login for WeChat Channels with encrypted server-side sessions: QR creation and polling remain pure HTTP, while a short-lived server-side headless browser imports the confirmed cookies once to capture the first-party request context required by the current comment APIs, then closes before background synchronization starts.
- Add a global session-switching view where every visitor can list and select any unexpired logged-in demo account, or add another account without replacing existing accounts; this demo intentionally has no administrator password, workspace boundary, or browser-session isolation.
- Add polling and normalization for inbound direct messages and comments from the authorized account.
- Show historical content without replying to it, establish a per-login baseline, and automatically reply only to new inbound content observed after that baseline.
- Generate replies server-side with exactly `doubao-seed-character-260628` through a separately configured model provider, while presenting only `chat角色模型` and `chat-llm` in the public UI.
- Send text replies directly through the corresponding private WeChat Channels endpoints and record only platform-confirmed outcomes as successful.
- Add a public demo page that shows QR/login state, global account selection, account state, inbound items, generated replies, delivery outcomes, and stop/logout controls.
- Keep login, synchronization, and automatic-reply workers in the service process so closing the page does not stop an unexpired account.
- Add fixed public HTTPS access at `https://dev.yytt.com.cn`, bounded retention, encrypted credential and customer-content storage, same-account worker uniqueness, idempotency, and a service-wide emergency stop as correctness protections; do not import AIDCP business strategies.

## Capabilities

### New Capabilities

- `multi-user-qr-auth`: QR authorization with one-time first-party request-context capture, encrypted session persistence, global demo-session selection, expiry, logout, and same-account worker uniqueness.
- `wechat-inbound-sync`: Baseline and incremental retrieval of WeChat Channels direct messages and comments with normalized records and durable deduplication.
- `ai-auto-reply`: Doubao reply generation and exact-target private-message/comment delivery for newly observed inbound items.
- `demo-operations-ui`: Public QR, global account switching, connection, content timeline, generic model presentation, reply outcome, stop, and logout experience with live updates.

### Modified Capabilities

None.

## Impact

- New standalone repository: `wechat-channels-ai-demo`.
- New TypeScript service, web application, SQLite state store, test suite, local deployment configuration, and an operator-provided Chrome/Chromium executable used only during post-scan context capture.
- External dependencies: private undocumented `channels.weixin.qq.com` endpoints and the configured Volcengine/Doubao model endpoint.
- The service will temporarily hold real customer WeChat Channels session credentials and interaction content. Credentials remain server-side and encrypted at rest; safe account summaries and selected-account content/actions are intentionally shared with every demo visitor, without an administrator or workspace access layer, until logout or retention expiry.
- Public access is provided through the fixed `https://dev.yytt.com.cn` HTTPS boundary with same-origin SSE. The client retains a bounded five-second authoritative snapshot-polling fallback for any temporary Quick Tunnel fallback.
- No existing AIDCP source, database schema, runtime service, deployment, or product behavior is modified.
