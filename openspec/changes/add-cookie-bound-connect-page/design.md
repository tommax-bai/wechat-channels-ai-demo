## Context

The existing `/` dashboard uses a browser-owned session cookie plus a shared-session selection cookie. That is appropriate for the Demo operator view, but it is not the requested customer flow: a focused visitor must see only login and business-WeChat-QR controls, and later visits must return to the Finder account previously scanned in that browser.

The platform identity is learned only after QR confirmation. A newly created transient session can also confirm an identity that already belongs to another retained Demo session, because the repository deliberately enforces one row per hashed Finder identity.

## Goals / Non-Goals

**Goals:**

- Serve a focused `/connect` page with only the two requested panels.
- Automatically create and start a QR login when the browser has no valid focused-page binding.
- Bind the browser to the retained account only after the platform returns a Finder identity.
- Reuse the already retained account when the same Finder identity is scanned through a new transient session.
- Scope business WeChat QR reads and mutations to the account bound to the focused page.

**Non-Goals:**

- Replacing or removing the existing dashboard and shared-session switcher.
- Changing worker polling, model/provider selection, content presentation, or partner APIs.
- Storing the raw Finder username in a browser cookie.
- Adding user registration, passwords, access-control roles, or a new service.

## Decisions

### Use separate focused-page cookies

The server will use one short-lived pending-login cookie and one long-lived account-affinity cookie, both HTTP-only and following the existing secure/same-site/max-age configuration. The pending cookie contains the normal opaque browser token and exists only while the Finder identity is unknown. The affinity cookie contains the opaque retained session ID selected after the Finder identity has been hashed and resolved server-side.

This avoids putting a raw Finder identifier in browser state and prevents `/connect` from changing the dashboard's existing browser-owner or shared-selection cookies. Reusing the dashboard cookies was rejected because it would couple the new page to shared-session selection.

### Provide focused endpoints instead of account-target headers

`GET /api/connect` returns the focused projection and ensures a QR exists when no valid binding is present. `POST /api/connect/login` refreshes the login QR. Focused `/api/connect/wechat-qr` endpoints read or mutate only the resolved affinity account and do not accept an account ID header.

This keeps the page script simple and makes the browser binding the sole source of the current account for this page. Reusing the dashboard's `x-demo-account-id` endpoint was rejected because it would make the client carry and choose the account target explicitly.

### Persist a duplicate-login handoff on the transient session

Add nullable `linked_session_id` to `demo_sessions`. When authentication learns a Finder identity whose keyed hash already belongs to another retained session, the worker records that retained session ID on the transient row while retaining the existing `account_already_connected` diagnosis. The next focused status request follows the handoff, sets the affinity cookie, clears the pending cookie, and returns the retained account projection.

The column is cleared whenever a session begins a new QR login. A durable handoff is required because the background login worker cannot set a browser response cookie. Deleting/replacing the retained account was rejected because it would discard its history, settings, and business WeChat QR.

### Reuse existing snapshots and business QR storage

The focused projection reuses `SessionService.snapshot` for current platform state and `get/set/deleteAccountWechatQr` for encrypted per-account asset storage. The new page renders only the required fields and does not receive private credentials or the Finder username.

## Risks / Trade-offs

- [A transient duplicate-login row remains until normal pending-session cleanup] → The handoff cookie is cleared immediately and the existing cleanup lifecycle removes the row; no extra cleanup worker is added.
- [An affinity cookie can point to an account that later becomes unavailable] → The server clears the invalid affinity and starts one fresh pending login in the same request.
- [GET `/api/connect` performs platform login creation on first visit] → This is the explicit requested behavior; subsequent polls reuse the pending cookie and do not create additional logins.
- [The new page is still a Demo account surface] → Keep it on the existing service and do not add unrelated authentication or warning UI.

## Migration Plan

1. Add the nullable column through the existing idempotent SQLite startup migration.
2. Deploy the new release without changing environment variables or service topology.
3. Verify old database rows map with `linked_session_id = NULL`, existing `/` behavior remains green, and `/connect` creates one pending login.
4. Roll back to the prior release if needed; the old binary ignores the additive nullable column.

## Open Questions

None.
