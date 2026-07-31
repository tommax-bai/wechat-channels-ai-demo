## Context

The deployed Demo currently gives every local session an absolute `expires_at` deadline and derives the browser-cookie lifetime from the same `SESSION_TTL_MS` setting. DEV sets that value to eight hours. Workers, shared-session listing, route resolution, reply admission, and cleanup all treat that local timestamp as platform authorization expiry even though WeChat did not supply it.

QR codes and abandoned pre-authentication sessions still need bounded cleanup. Authenticated platform sessions instead need to survive page closure and process restarts until WeChat rejects the stored authority or the operator logs the account out.

## Goals / Non-Goals

**Goals:**

- Preserve authenticated platform sessions without a Demo-owned absolute expiry.
- Upgrade already authenticated DEV rows without resetting credentials or requiring a new scan.
- Keep QR tokens and abandoned unauthenticated sessions bounded.
- Stop synchronization and sends when a platform response explicitly reports `auth_required`, and expose the existing fresh-QR recovery path.
- Remove authenticated-session expiry timestamps from public API and UI copy.

**Non-Goals:**

- Claiming that WeChat provides a documented or permanent session lifetime.
- Refreshing or bypassing platform authorization after WeChat rejects it.
- Changing account sharing, model selection, reply policy, or source polling behavior.
- Adding a long-term retention or privacy policy to this technical Demo.

## Decisions

### 1. Separate platform persistence from transient cleanup

Add an additive `platform_persistent` flag to `demo_sessions`. `expires_at` remains the cleanup deadline for sessions that have not completed authentication. Completing authentication sets `platform_persistent=1`; refreshing a QR resets it to `0` and assigns a fresh transient deadline.

All session-retention predicates become `platform_persistent = 1 OR expires_at > now`. Cleanup deletes only non-persistent rows past their deadline. This preserves the existing schema and foreign-key cascade while making the no-local-expiry state explicit.

Using a very distant timestamp alone was rejected because it would continue to encode platform authority as a fabricated date and could leak back into UI projections.

### 2. Upgrade authenticated rows in place

Database startup adds the flag when missing and promotes rows that already have a bound account identity in an authenticated or recovery state. It also moves their legacy deadline to a far-future rollback-compatible value so an immediate rollback to the old build does not delete them.

No credential payload is decrypted during migration, and no table rebuild is required.

### 3. Keep browser selection durable but separate from platform authority

Rename `SESSION_TTL_MS` to `PENDING_SESSION_TTL_MS` for abandoned pre-authentication cleanup. Give the opaque browser selection cookie its own `SESSION_COOKIE_MAX_AGE_SECONDS` setting. Cookie expiry may create a new browser selector, but it does not delete or stop any globally shared authenticated platform session.

### 4. Treat explicit platform authentication errors as the authority boundary

Synchronization already projects a platform `auth_required` response into the session state. The send path will do the same for an unambiguous pre-receipt `auth_required` failure. Once projected, normal worker and reply admission stops because only `baseline_sync`, `active`, and `stopped` sessions are eligible.

Network timeouts and ambiguous post-dispatch outcomes do not prove logout and therefore retain their current honest outcome handling.

### 5. Remove fabricated expiry from public projections

`expiresAt` is removed from authenticated session snapshots and shared account summaries. The page states that the login is maintained by the platform and displays a fresh-QR prompt only when the authoritative session state becomes `auth_required`.

## Risks / Trade-offs

- [Authenticated sessions remain stored longer] → Keep explicit logout/delete, encrypted credentials, and the existing account cap; this Demo intentionally favors uninterrupted demonstrations over automatic data retention.
- [The platform silently revokes a session between polls] → The next sync or send receives `auth_required`, stops work, and prompts for a fresh QR.
- [Rollback reads the legacy expiry column] → Promote authenticated rows to a rollback-compatible far-future deadline in addition to setting the new flag.
- [Abandoned QR sessions accumulate] → Keep a separate transient cleanup deadline and cleanup worker.

## Migration Plan

1. Add the `platform_persistent` column and startup promotion for existing authenticated rows.
2. Update repository predicates, login transitions, API projections, UI copy, configuration, and tests.
3. Validate lint, typecheck, tests, build, audit, and strict OpenSpec.
4. Fast-forward the clean standalone `main`, back up the DEV release and SQLite database, deploy from `main`, and restart only `wechat-channels-ai-demo.service`.
5. Verify the existing account remains listed without an expiry, workers remain active, and an injected/tested explicit auth failure still projects `auth_required`.

Rollback restores the previous release and database backup. No AIDCP or isales service is changed.

## Open Questions

None.
