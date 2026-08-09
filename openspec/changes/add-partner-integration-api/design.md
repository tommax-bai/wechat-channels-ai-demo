## Context

The service already persists multiple WeChat Channels sessions and runs QR polling, comment/DM synchronization, and reply workers independently of the browser page. Its HTTP contract is currently coupled to a same-origin browser Cookie and an implicitly selected session, so it cannot be handed to another backend as a stable integration API.

The external caller needs to render its own login and content UI. It must distinguish QR scan progress from completed login and from a later platform-declared credential expiry. Reply selection has two existing providers, while the Funnel contract accepts a known job number but exposes no job catalogue endpoint.

## Goals / Non-Goals

**Goals:**

- Expose a small versioned server-to-server API for account, login, hosting, reply settings, comments, and direct messages.
- Use one explicit opaque account identifier on every account-scoped call.
- Preserve the current worker and persistence authority rather than creating a parallel integration path.
- Publish exact status mappings, payloads, errors, polling guidance, and curl examples.
- Keep secrets, platform identifiers, concrete model names, and upstream service details out of responses.

**Non-Goals:**

- Browser-direct CORS access or embedding the static API key in frontend JavaScript.
- API-key scopes, per-customer tenancy, rate limiting, webhooks, or an idempotency store.
- Discovering or validating Funnel jobs; the upstream contract has no catalogue or lookup operation.
- Exposing raw WeChat credentials, request context, reply targets, Finder identifiers, or platform cursors.
- Changing the existing Demo page, Cookie API, sync loop, or reply-send behavior.

## Decisions

### Use a dedicated Bearer-protected route namespace

All integration routes live under `/partner/v1` and require `Authorization: Bearer <PARTNER_API_KEY>`. The optional deployment setting must contain at least 32 characters. If it is absent, the namespace returns `partner_api_unavailable`; a missing or mismatched credential returns `partner_api_unauthorized`. Authentication uses a constant-time digest comparison, request logging already redacts `Authorization`, and readiness exposes only a configured boolean.

This is preferred over reusing the browser Cookie API because the latter has implicit account selection and same-origin mutation semantics. CORS is intentionally not enabled: the colleague's backend holds the key and proxies the data needed by its own frontend.

### Reuse the persisted session ID as an opaque account ID

`POST /partner/v1/accounts` creates the same durable session row used by existing workers but starts with automatic replies disabled. The internal digest is returned as `accountId` and treated as opaque by the caller. Account listing reads every retained non-logged-out session, including new and QR-pending accounts, while account resolution still enforces the existing retention rules.

This avoids a second ownership table for a single Demo-wide integration key. Multi-tenant ownership and distinct external IDs are deliberately deferred.

### Keep QR, login, and hosting status separate

`POST /accounts/{accountId}/login/qr` creates or refreshes a login attempt and returns the projected login state. `GET /accounts/{accountId}/login/status` polls it. A refresh is allowed for a new/pending/expired/cancelled/no-account attempt, platform-expired session, or failed initialization that has no persisted session credential; an in-progress or valid hosted account returns a conflict instead of silently deleting its credentials and content.

The public login state maps the worker state to `not_requested`, `waiting_scan`, `scanned`, `initializing`, `succeeded`, `qr_expired`, `cancelled`, `no_account`, `login_required`, or `failed`. `scanned` never means login succeeded. A QR data URL and QR expiry apply only to the current QR attempt.

Hosting reports `not_ready`, `initializing`, `active`, `paused`, `degraded`, or `expired`. Only `auth_required` together with an already persisted platform session credential yields `loginExpired: true`; an initialization error that reuses the internal state name remains `failed`/`not_ready`. The API returns `credentialExpiresAt: null` and never derives an eight-hour expiry from a local timer or database compatibility sentinel.

### Expose existing provider selection without upstream internals

`GET /partner/v1/capabilities` returns configured availability and whether a provider requires a job number. `PUT /accounts/{accountId}/reply-settings` accepts `chat-llm` or `funnel`; Funnel requires a trimmed `jobNumber`. It stores the selected known job number but does not invent a job listing endpoint. Responses never contain the concrete Ark model name, Ark/Funnel credentials, Funnel host, or provider request IDs.

`PUT /accounts/{accountId}/hosting` controls the existing automation flag. Source synchronization continues under the existing worker behavior even when replies are paused.

### Add source-specific keyset pagination

Comments and direct messages use separate endpoints. Repository reads filter by `session_id` and source and order by `(discovered_at DESC, id DESC)`. An opaque base64url cursor contains a version, account ID, source, discovery timestamp, and row ID; it is rejected if reused for another account or source. Limits default to 50 and are capped at 100.

Each item decrypts only the normalized author name and text needed by the integration. Reply output preserves `messages` for multi-part DM replies and returns state, text, error code, and update time. Raw platform targets, identifiers, envelopes, model fields, and upstream request IDs remain internal.

### Publish Markdown and OpenAPI documentation

`docs/partner-api.md` is the operator-facing guide and `docs/partner-api.openapi.yaml` is the importable contract. Both describe server-to-server use, status semantics, polling, provider/job selection, pagination, errors, and the absence of a job catalogue. They use placeholders only and contain no deployed secrets.

## Risks / Trade-offs

- [One API key can access every Demo account] -> This matches the explicitly requested shared Demo scope; the key remains server-side and can be rotated through the deployment environment.
- [Returning message text exposes personal content to the integration] -> Access is explicit under the Bearer key, responses are `no-store`, and raw credentials/targets are excluded.
- [QR creation resets a pending attempt and its not-yet-hosted data] -> Valid and in-progress hosted states are rejected; the behavior is documented.
- [Funnel job numbers cannot be discovered or prevalidated] -> The API accepts only a caller-supplied known value and reports provider errors through the existing reply state.
- [Polling the first content page observes mutable reply state] -> Items have stable IDs and documentation instructs callers to upsert rather than append blindly.
- [Cursor rows can disappear after account deletion or relogin] -> The next read safely returns an empty page; cursors are not durable bookmarks across account resets.

## Migration Plan

1. Add the optional configuration and routes with focused tests; no existing route changes its contract.
2. Add the source/time/index migration through idempotent SQLite startup DDL.
3. Deploy the clean `main` build to the independent DEV Demo service and configure a newly provisioned `PARTNER_API_KEY` without printing it.
4. Verify health, authenticated/unauthenticated Partner calls, account lifecycle, and existing browser API behavior; restart only the Demo unit.
5. Roll back by restoring the previous release and environment backup. The additional index is backward compatible and may remain.

## Open Questions

- A discoverable job dropdown remains blocked until the Funnel owner publishes an authoritative job list/detail contract.
- Browser-direct integration would require a separately approved origin and short-lived browser credential design; it is not implied by this API.
