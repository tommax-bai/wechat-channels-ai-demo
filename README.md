# WeChat Channels AI Demo

一个完全独立的多用户视频号 AI 自动回复 Demo：

- 不依赖 AIDCP Edge、Cloud、Console、数据库或业务策略；
- 不启动 Chrome、AdsPower、Electron 或其他浏览器内核；
- 客户打开网页后，通过纯 HTTP 视频号二维码登录；
- 历史私信和评论只展示并建立基线；
- 基线完成后，新收到的文本私信、顶层评论和二级评论由 `doubao-seed-character-260628` 生成并直接回复；
- 每个访客使用独立的服务端租户会话。

> 视频号助手端点是私有、未文档化接口。本仓库是技术 Demo，不是微信官方 SDK，也不能在完成真实账号逐项验收与合规评估前视为生产集成。

## Architecture

```text
Customer browser
    │  HTTPS + HttpOnly cookie + SSE
    ▼
Single Fastify service
    ├─ isolated demo sessions
    ├─ browserless QR login worker
    ├─ WeChat private-API adapter
    ├─ DM/comment baseline and incremental poller
    ├─ Doubao generation and exact-target sender
    └─ SQLite WAL
```

每个浏览器 Cookie 是 256 位随机值，SQLite 只保存其 SHA-256。视频号 CookieJar、身份、私信游标、消息正文、目标信息和模型回复使用 AES-256-GCM 字段级加密，AAD 绑定当前租户和记录用途。同一视频号身份只能绑定一个保留中的 Demo 会话。认证完成后，服务不会按本地时钟强制结束登录态；只有主动退出或视频号接口明确返回登录失效才要求重新扫码。

## Local run

Requirements:

- Node.js 22.13 or newer;
- a 32-byte encryption key;
- a Volcengine Ark API key with access to `doubao-seed-character-260628` if automatic replies should run.

```bash
cp .env.example .env
openssl rand -base64 32
# Put the generated value in SESSION_ENCRYPTION_KEY.
# Put the Ark key in ARK_API_KEY.
npm ci
npm run check
npm run dev
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310).

If `ARK_API_KEY` is empty, QR login and read-only UI can still run, but automatic reply remains disabled. The service never silently falls back to another model.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `SESSION_ENCRYPTION_KEY` | Base64 or 64-hex 32-byte AES key | required |
| `SESSION_COOKIE_SECURE` | Require HTTPS for the browser session cookie | production: `1`, otherwise `0` |
| `SESSION_COOKIE_MAX_AGE_SECONDS` | Opaque browser selector cookie lifetime; does not control platform login | `365d` |
| `DATABASE_PATH` | Isolated SQLite database | `./data/demo.sqlite` |
| `PENDING_SESSION_TTL_MS` | Cleanup deadline for abandoned, unauthenticated Demo sessions | `24h` |
| `MAX_ACTIVE_SESSIONS` | Concurrent retained visitor/account cap | `100` |
| `WORKER_CONCURRENCY` | Cross-tenant auth, sync, and reply concurrency cap | `4` |
| `WECHAT_BASE_URL` | WeChat Channels origin or a test double | official origin |
| `DEMO_AUTO_REPLY_ENABLED` | Service-wide new-job switch | `1` |
| `ARK_API_KEY` | Volcengine Ark inference key | empty |
| `ARK_BASE_URL` | Ark OpenAI-compatible inference base URL | Beijing `/api/v3` |
| `ARK_MODEL` | Exact model or endpoint ID | `doubao-seed-character-260628` |

Secrets and message bodies are never included in startup summaries or request-error logs.

## Behavior

### Authentication

`new → qr_pending → scanned → baseline_sync → active`

The service maintains one complete `tough-cookie` jar from the initial login-code response onward. A QR poll result alone is not login success: `/auth/auth_data` must return a Finder identity and the helper endpoint must return a UIN before the service stores an authenticated session.

Authenticated sessions remain encrypted on the server across page closure and service restart. The Demo does not invent an eight-hour platform expiry. An explicit `auth_required` response from WeChat changes the account to a visible re-login state and stops new synchronization and sends until a fresh QR succeeds.

### Baseline and new content

- The first valid snapshot for each source is stored as historical.
- Paginated history remains in baseline state until the platform reports no next page.
- Comment cursors bind the stable post `objectId/exportId`; a reordered post list cannot move an in-progress cursor to another post.
- Comment reply contexts must match the captured 15-field platform shape exactly; wrong ID or field types fail closed before a reply job can dispatch.
- Historical content never creates reply jobs.
- One source can remain visibly unavailable while the other source operates.
- A stable platform event ID is required for deduplication.
- New items received while the customer has stopped automation are displayed but do not create delayed reply jobs.

### Reply outcomes

`queued → generating → generated → sending → confirmed | failed | submitted_unknown`

- Comment success requires a non-empty platform `commentId`.
- Direct-message success requires a non-empty platform `svrMsgId`.
- An explicit platform rejection is `failed`.
- A timeout, disconnect, oversized response, or unreadable response after an irreversible send is `submitted_unknown`.
- `submitted_unknown` is never automatically resent.
- A stop/resume/logout generation is checked again before sending.
- Logout prevents a request that has not reached the dispatch boundary; it cannot revoke a request already submitted to WeChat.
- Platform I/O is serialized per demo session so concurrent sync and send requests cannot overwrite each other's refreshed cookies; different visitors still progress concurrently.
- QR refresh and logout return `409 platform_send_in_flight` while an already-dispatched send outcome is being persisted. The visitor can retry immediately after it reaches a terminal state.

## HTTP routes

| Route | Purpose |
|---|---|
| `GET /` | Demo page |
| `GET /healthz` | Process health |
| `GET /readyz` | Safe configuration readiness |
| `GET /api/session` | Create/read owning visitor session |
| `POST /api/session/login` | Request or refresh QR login |
| `POST /api/session/automation` | Stop/resume new automatic replies |
| `GET /api/events` | Authenticated SSE state notifications |
| `DELETE /api/session` | Delete credentials, content and tenant scope |

Account, Finder, message and reply-target IDs are never accepted from the browser.

## Security and product limits

- This is a single-instance technical Demo, not a horizontally scaled production service.
- One process serves multiple isolated visitors with bounded cross-tenant worker concurrency; it is not a high-volume queue.
- WeChat private endpoints and response shapes can change without notice; each source fails closed on unknown required fields.
- New inbound text and the generated reply are sent to the configured Volcengine Ark account. The operator must disclose and approve that data flow.
- The fixed prompt blocks obvious credential requests, but the Demo does not provide a complete moderation, policy, or human-approval system.
- Public exposure requires HTTPS, network-level rate limiting, a deployment-specific encryption key, explicit logout/data removal, and an explicit privacy/compliance review.
- A platform write is counted only when the expected platform ID is returned. Ambiguous writes are not retried automatically.
- The initial scope handles inbound text DMs plus top-level and second-level text comments; non-text media is not automated.

## Docker

```bash
cp .env.example .env
# Configure SESSION_ENCRYPTION_KEY, ARK_API_KEY, HOST=0.0.0.0
docker compose up --build
```

Public deployment requires HTTPS and a unique encryption key. Do not copy a development SQLite file or encryption key into a customer-facing deployment.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
openspec validate build-multi-user-wechat-ai-demo --strict
```

Automated tests use fake WeChat and Ark servers. They never scan a real account or submit a platform write. See [Live validation checklist](docs/live-validation.md) for the remaining real-account gates.

The current DEV host keeps the application loopback-only and publishes an
ephemeral HTTPS URL through an independent Cloudflare Quick Tunnel service.
See [DEV deployment](docs/dev-deployment.md).
