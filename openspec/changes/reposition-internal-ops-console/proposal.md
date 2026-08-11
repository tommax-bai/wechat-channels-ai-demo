# Reposition As An Internal Ops Console

## Why

The service was framed as a customer-facing self-service demo: any browser that opened the page silently received its own tenant session, and every visitor could see and operate the full shared account list without any access control. The product is now operated by internal staff who manage a shared pool of Video Channels accounts, so the anonymous-visitor framing is wrong in both directions: it creates junk sessions for every page view and leaves the whole console open to anyone who can reach it.

## What Changes

- Add a single shared operator password (`OPS_PASSWORD`). When configured, the console page APIs answer `401 ops_auth_required` until the browser exchanges the password for an HttpOnly cookie at `POST /api/ops/login`; the page shows a login overlay in that state. No per-operator identity, roles, or audit are added.
- Keep the customer-facing `/connect` page (with `/api/connect/*`) and the separately authenticated `/partner/v1` API entirely outside the ops gate, unchanged.
- Stop creating a session when the page is merely opened: `GET /api/session` now only reads an existing selection, and account sessions are created solely by the explicit add-account action or the connect/partner flows.
- Reframe the console UI as an internal ops backend: the account list becomes the primary view, demo copy becomes console copy, and per-account logout becomes "移除账号".

## Capabilities

### New Capabilities

- `ops-console-access`: shared-password admission to the operator console and explicit-only account-session creation.

### Modified Capabilities

None.

## Impact

- Config gains optional `OPS_PASSWORD` (minimum 8 characters); startup summary reports only whether it is configured.
- `src/server.ts` gains the gate hook, the login route, and loses the visitor auto-create path; `SessionService` loses the now-unused `ensureBrowserSession`.
- `public/` console copy, default view, and a login overlay; no change to `connect.html`/`connect.js`.
- Tests bootstrap accounts through the explicit create route; new coverage for the gate, the exempt surfaces, and the no-auto-create behavior.
- Sync, reply, storage, encryption, and the Partner API contract are unchanged.
