## Context

This is a greenfield customer-facing demo, not an AIDCP feature branch. It must run as one independently deployable service and must not import or call AIDCP Edge, Cloud, Console, account, approval, risk, pacing, or orchestration components.

The WeChat Channels creator-assistant endpoints are private and undocumented. A live probe has established that a login code can currently be requested and polled without a browser, but post-scan session capture, non-empty direct-message/comment reads, and real sends remain live-account validation gates. The service therefore isolates all platform-specific shapes behind one adapter and reports unsupported or changed schemas explicitly.

The demo is multi-account and intentionally shared. WeChat credentials stay encrypted server-side, while every visitor can list and select any unexpired authenticated demo session through opaque server-generated identifiers. There is no administrator password, workspace boundary, or browser-session isolation in this demo. Expiry, logout, exact selected-session resolution, and one worker per Finder identity still apply.

## Goals / Non-Goals

**Goals:**

- Serve one polished demo page and its API from a single Node.js process.
- Let visitors request and scan browserless WeChat Channels login QR codes while preserving all existing logged-in accounts in a global shared session list.
- Let every visitor switch the active demo session without an administrator, workspace, or browser-ownership check.
- Encrypt every persisted platform credential and bind it to exactly one demo session and one observed Finder identity.
- Baseline existing direct messages and comments, display them, and auto-reply only to newly discovered inbound items.
- Generate plain-text replies with exactly `doubao-seed-character-260628` on the server while exposing only `chat角色模型` and `chat-llm` in the public page.
- Send each reply to the exact source item at most once automatically and project platform-confirmed, failed, and ambiguous outcomes honestly.
- Make login, sync, model, send, stop, logout, and schema errors visible in the page.
- Keep workers running for unexpired sessions independently of whether any browser page or event stream remains open.
- Support a public HTTPS demo path with SSE where supported and bounded snapshot polling where the public proxy does not support SSE.

**Non-Goals:**

- Production SLA, horizontal scaling, billing, organization accounts, permanent customer onboarding, or long-term data retention.
- Per-visitor account privacy, administrator authentication, workspace membership, or browser-session isolation.
- Browser, AdsPower, Electron, AIDCP protocol, AIDCP database, or AIDCP policy integration.
- Image, audio, video, proactive outbound, bulk historical replies, publishing, content browsing, likes, follows, or cross-account orchestration.
- Claiming the private endpoints are official or stable.
- Automatically retrying an irreversible reply whose platform result is unknown.

## Decisions

### 1. One Fastify service with a static web client and internal workers

The repository uses TypeScript, Fastify, a static HTML/CSS/JavaScript client, and one SQLite database. Login polling, inbound synchronization, model generation, delivery, and expiry cleanup are internal bounded workers in the same process. A small configurable concurrency cap allows different sessions to progress in parallel while reply jobs and cookie-mutating WeChat platform I/O for one account remain serialized. Browser navigation, page closure, SSE disconnects, and snapshot-polling disconnects do not own or stop those workers.

This is smaller and easier to run than a React build plus separate queue service. SQLite in WAL mode is sufficient for a single-instance demo and provides the transactions and unique constraints needed for session scoping, account uniqueness, and deduplication. Horizontal replicas are explicitly out of scope; PostgreSQL and a durable external queue would be required before scaling out.

### 2. Opaque cookies select from one global demo-session pool

The browser initially receives a random 256-bit base-session cookie whose SHA-256 digest is stored in SQLite. Authenticated unexpired demo sessions are projected into a global safe account list. A visitor may send only one opaque server-created demo-session identifier to select an entry; a separate HttpOnly selection cookie makes subsequent snapshot, SSE, stop/resume, login-refresh, and logout routes resolve that selected session. Adding an account creates a fresh base session, clears the selection, and does not replace existing logged-in sessions.

This is deliberately not an authentication or tenant boundary: any visitor can list, select, view, and operate any shared demo account. No administrator password, workspace, or browser ownership check is added, and the page does not require a shared-access warning or consent gate. Same-origin mutation checks, bounded active-session creation, and response schemas still prevent untrusted origins and direct platform-target injection. The client may select only the opaque demo-session identifier; it cannot supply a Finder ID, QR token, message target, reply target, raw cookie, UIN, or model-provider credential.

### 3. AES-256-GCM protects credentials at rest

The service requires a 32-byte `SESSION_ENCRYPTION_KEY`. QR tokens, post-login platform session material, inbound author/text/target data, cursors, and generated replies are stored in versioned AES-256-GCM envelopes with the demo-session digest and record purpose as additional authenticated data. Stable external IDs and Finder identities are represented outside the envelope only by keyed HMAC digests for deduplication and exclusive-account binding. Logout and expiry delete the credential row and all session-owned content.

An in-memory-only alternative would lose every login on restart and make the demo unreliable. Plain SQLite values are unacceptable because this internet-facing service centrally holds customer session authority.

### 4. Pure HTTP login is a state machine behind a platform adapter

The adapter owns `auth_login_code`, `auth_login_status`, `auth_data`, helper UIN, and private-message login-cookie calls. The application sees only:

`new -> qr_pending -> scanned -> authenticated -> baseline_sync -> active`

Terminal/recoverable states include `expired`, `cancelled`, `no_account`, `auth_required`, `schema_changed`, `stopped`, and `logged_out`.

Only an identity-bearing `auth_data` response plus required session material establishes `authenticated`. QR creation, polling success, or cookie presence alone never does. A fresh QR replaces the previous pending token for the same demo session.

### 5. Baseline and incremental content share one normalized inbox

The platform adapter maps direct messages and top-level or second-level comments into `InboundItem` records containing source type, immutable external item ID, exact reply target fields, author display name, text, platform timestamp, and raw-shape version. Comment pagination binds its durable cursor to the current post's stable `objectId/exportId` and fails closed if that identity disappears, instead of applying a continuation cursor to a reordered post. Every comment node receives its own sanitized write context with an empty nested-comment array; all captured string, finite-number, and boolean fields must have their exact types and the context comment ID must match the normalized target ID. A unique key on `(demo_session_id, source, external_item_id)` prevents duplicate processing.

Every page in the first source snapshot is inserted with `reply_eligible=false`; the durable baseline flag changes only after the platform reports no continuation page. Later unseen inbound items are eligible only if they are authored by someone other than the authenticated Finder identity and were first observed after the baseline. Historical content remains visible but cannot enter the reply queue. One Finder identity HMAC may be bound to only one unexpired demo session so repeated logins or multiple visitors cannot run duplicate auto-repliers for the same account. All post-await source, inbox, cursor, and credential writes compare the expected authentication generation so an old account request cannot pollute a refreshed login.

### 6. Reply processing is durable but irreversible sends are not retried blindly

An eligible item moves through:

`queued -> generating -> generated -> sending -> confirmed|failed|submitted_unknown`

Claiming and state transitions are transactional. An atomic pre-send transition and a final callback immediately before network dispatch verify the session, auth generation, run generation, expiry, and stop state. Model failures before sending may be manually retried later, but the initial demo performs one automatic generation attempt. Once a send is dispatched, a timeout, connection loss, unparseable response, HTTP server error, or process crash is recorded as `submitted_unknown` and is never automatically resubmitted. Platform-confirmed success requires the endpoint-specific server ID and is stored before refreshed credential material. QR refresh, logout, and expiry cleanup cannot delete a `sending` job; refresh/logout return a conflict until the receipt reaches a terminal state.

Per-session stop and a global `DEMO_AUTO_REPLY_ENABLED` switch prevent new claims but do not rewrite existing outcomes. These are correctness controls, not imported AIDCP policies.

### 7. The exact server model is hidden behind generic public copy

`ReplyModel` accepts normalized source, author, message text, and a fixed customer-service system prompt, and returns bounded plain text. The production implementation uses the Volcengine Ark OpenAI-compatible API with `ARK_API_KEY`, `ARK_BASE_URL`, and `ARK_MODEL`; the default requested model identifier is `doubao-seed-character-260628`, but startup diagnostics must truthfully report whether the configured account accepts the exact ID.

Tests use an injected fake model. The Ark call has one end-to-end timeout and a bounded response body; only complete `finish_reason=stop` text is accepted. Model output is trimmed, stripped of empty content, and bounded to the platform text limit; no fallback model is selected silently. Public HTML, JavaScript, and API projections do not expose the concrete model identifier: the page uses `chat角色模型`, `chat-llm`, and `CHAT回复`.

### 8. The page uses selected-session SSE with a proxy-compatible polling fallback

The static client loads a snapshot for the cookie-selected session and, on compatible origins, subscribes to a same-origin SSE endpoint resolved through the same selection. Events contain only safe projected data. The page shows QR expiry, login identity display name, baseline progress, inbound content, generated reply, delivery status, last sync, and stop/logout actions.

The public Cloudflare Quick Tunnel used by this demo does not support SSE. On `.trycloudflare.com`, the client therefore does not open `EventSource` and instead reloads the authoritative session and shared-session snapshots on a fixed five-second interval. The same bounded interval may also repair missed UI state on compatible origins, while SSE remains the low-latency path. WebSockets add unnecessary bidirectional protocol surface for a server-originated update stream.

## Risks / Trade-offs

- [Private WeChat endpoint or schema changes] → Keep endpoint descriptors and parsers isolated, validate bounded shapes, mark only the affected capability `schema_changed`, and expose diagnostics without credentials.
- [A customer grants a central demo service account authority] → Explain the boundary on the login page, encrypt at rest, use short retention, provide immediate logout/delete, and do not deploy publicly without HTTPS.
- [Any public visitor can operate a shared logged-in account] → Treat this as an explicit demo convenience rather than tenant isolation; keep credentials opaque, enforce exact selected-session resolution, retain the session TTL and same-account worker uniqueness, and do not add a page warning or access gate that the demo did not request.
- [A reply send times out after reaching the platform] → Record `submitted_unknown` and never automatically resend.
- [Historical content is mistaken for new content] → Complete a durable source-specific baseline before setting any item `reply_eligible=true`.
- [Two workers process one inbound item] → Use transactional claims, unique keys, and a single-instance worker lease.
- [The requested Doubao model ID is unavailable to the configured account] → Fail startup/model diagnostics visibly; do not substitute another model.
- [SQLite limits future scale] → Keep persistence behind repositories; move to PostgreSQL before multi-replica or production use.
- [Private APIs may violate platform expectations or terms] → Label the artifact as a technical demo and require a separate compliance decision before production/customer rollout.

## Migration Plan

1. Build and validate locally with mocked WeChat and model servers.
2. Run a real-account DEV login validation without enabling automatic sends.
3. Validate non-empty direct-message and comment reads against an explicitly selected demo account.
4. Enable one exact disposable direct-message and comment target for live send verification only after separate approval.
5. Deploy one public HTTPS instance with a fresh encryption key and model credentials; keep the application listener on loopback and do not copy local SQLite or session material.
6. Roll back by stopping the service and deleting its isolated deployment volume; no AIDCP service or data is involved.

For the DEV public demo, the service uses an isolated verified Node.js 22
runtime, a dedicated unprivileged system user, a root-owned environment file,
and a loopback-only application listener. A separately managed Cloudflare Quick
Tunnel provides the public HTTPS hostname and the application keeps Secure
cookies enabled. The Quick Tunnel transport uses the five-second snapshot
polling fallback described above; it does not change worker ownership or widen
the demo into an AIDCP service.

## Open Questions

None for the initial implementation. Exact live private-response shapes and exact model-account activation remain validation gates rather than design choices.
