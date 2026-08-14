# Design

## Retirement happens inside the completion transaction

`completeAuthentication` now looks up the current holder of the incoming `account_key_hash` and retires it in the same SQLite transaction that completes the new login. The unique constraint on `account_key_hash` therefore can never reject a re-login, and no observable state exists in which two containers both host one account or neither does. A crash rolls both sides back together; the account keeps its previous container until a scan actually completes.

## What retirement means

The retired row keeps its history but loses every live capability:

- `auth_state = 'logged_out'` removes it from retained listings, shared resolution, worker admission, and Partner resolution.
- `account_key_hash = NULL` releases the unique binding and — deliberately — keeps the startup platform-persistence migration from resurrecting the row, because that migration promotes only rows that still hold an account binding.
- `platform_persistent = 0` plus `expires_at = now + pendingSessionTtlMs` hands the row to the ordinary expired-session cleanup: operators get one standard retention window to inspect it, then the cascade removes its history.
- Generation bumps invalidate any in-flight worker writes and send authorizations; queued reply jobs fail as `account_superseded` so nothing silently answers on behalf of a superseded login.
- The dead credential envelope is deleted — the platform has superseded that cookie jar, so keeping it is pure liability.

## The successor inherits account-level configuration

Reply provider, funnel job number, and the business WeChat QR asset describe how the *account* behaves, not which container hosts it. The provider settings copy inside the retirement transaction. The QR asset requires re-encryption under the successor's key scope, so the worker carries it over best-effort after the transaction: a lost carry costs one re-upload, whereas a failed login would cost the customer another scan.

`automation_enabled` is intentionally not copied: a fresh scan expresses intent to host, and both creation flows already choose the automation default for the new container.

## Browsers follow the handoff; the Partner API does not

The `/connect` affinity cookie names a container, so a cookie left pointing at a retired container follows the `linked_session_id` chain (bounded hops, since each re-login adds a link) and rebinds to the live successor. The classic per-browser session cookie and the Partner API deliberately do not follow: their identifiers denote the container itself, and both callers already handle a vanished container (session reset, `partner_account_not_found`) — the Funnel backend in particular always starts from a freshly created account, which now simply wins the takeover.
