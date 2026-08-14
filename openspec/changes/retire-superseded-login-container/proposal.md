## Why

A WeChat Channels account can be hosted by only one Demo container, and today that binding is permanent until an explicit logout: when the account scans a login QR issued to any other container, the capture succeeds but the credentials are discarded and the login is reported as `account_already_connected`. The Funnel backend creates a fresh Partner account for every login attempt, so every re-login of an already-retained account fails, and the retained container keeps its expired credentials. This is exactly what stranded the retained account "为啊喂" on DEV on 2026-08-14: its fresh scan was captured at 10:43:52 and then thrown away.

## What Changes

- A completed platform login always takes ownership of its Finder identity: any other container currently holding the same account is retired inside the same transaction that completes the new login.
- A retired container becomes `logged_out` with the diagnosis `superseded_by_relogin`, releases its account binding and platform persistence, records its successor in `linked_session_id`, fails its queued reply jobs as `account_superseded`, drops its dead encrypted credentials, and leaves through the ordinary transient-session cleanup after the standard pending-session retention window.
- The successor container inherits the retired container's reply provider, funnel job number, and business WeChat QR asset, so a re-login does not silently reset how the account replies.
- Focused `/connect` browsers whose affinity cookie points at a retired container follow the recorded successor chain instead of being asked to scan again.
- `account_already_connected` is no longer produced; the duplicate-login handoff record (`linkAuthenticationToExistingAccount`) is removed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `multi-user-qr-auth`: The single-container-per-account invariant is now enforced by retiring the previous holder in favor of the newest completed login rather than by rejecting the new login.
- `cookie-bound-connect-page`: A duplicate focused login now binds the browser to its own newly authenticated container, and stale affinity cookies follow the retirement handoff to the successor.
- `partner-integration-api`: A fresh Partner account can take over an already-hosted Finder identity; the retired account disappears from Partner listings and resolves as `partner_account_not_found`.

## Impact

- Authentication completion transaction, retirement bookkeeping, and queued-reply failure in the repository; login-completion worker and QR asset carry-over.
- `/connect` affinity resolution follows `linked_session_id` chains.
- No schema change; existing rows and the duplicate-linked rows written by the previous behavior remain readable.
- The Funnel backend's create-account-then-scan flow now succeeds without changes on its side.
