## Why

A retained DEV account lost direct-message synchronization ten seconds after login and stayed silent for fifty minutes without a single retry. The source recorded `schema_changed:data.cookie` and the worker treats a direct-message `schema_changed` as terminal: it returns immediately on every later tick, so the only recovery is a fresh QR scan, which deletes the account's entire retained inbox and rebuilds both baselines.

A read-only probe against that same account's stored credentials showed the platform contract is intact: `get-history-msg` returned `msg`, `baseResp.errcode=0`, `isContinue=false` and a 24-character `cookie`, and `get-login-cookie` returned an 8-character `cookie`. The exact call that was recorded as a permanent schema change succeeds when repeated. The failure was therefore a start-up race — the account had just finished its scan, the short-lived direct-message login cookie was not yet issued, and a blank value was classified as a missing field.

Two defects combine here. A transient blank value is reported as a structural contract change, and a direct-message source that reports a structural change never retries. Every newly scanned account runs the same race, so this is a systematic start-up hazard rather than one account's bad luck.

## What Changes

- Classify an absent or blank direct-message pagination cursor as a retryable `dm_cursor_unavailable` failure instead of `schema_changed:data.cookie`, and name the observed top-level response keys in the recorded error without exposing any value.
- Give every failed source a bounded, exponentially paced retry schedule with a persisted consecutive-failure count and next-attempt time, so no source is permanently abandoned and no source polls a failing endpoint at full cadence.
- Remove the terminal direct-message `schema_changed` branch; a genuine schema change now backs off on a slow schedule and stays visibly degraded rather than silently dead. The superseded comment cursor recovery keeps its existing baseline-reset semantics.
- Log every source synchronization failure with source, masked session, error code, consecutive failure count and next retry delay, and log the recovery when a previously failing source succeeds again.
- Split the customer-facing source wording so a retrying failure no longer claims the platform interface changed.

Deliberately not changed: the recognized cursor field names stay `cookie` and `nextCursor`. The probe proved the platform still uses `cookie`, so widening the alias list would add speculative surface with no observed need.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wechat-inbound-sync`: replace terminal per-source failure handling with bounded exponential retry, reclassify blank direct-message cursors as retryable, and require diagnostic logging for every source failure.

## Impact

- Direct-message cursor handling in `src/wechat/client.ts`.
- Source failure pacing, retry scheduling and failure logging in `src/service/workers.ts`.
- `source_states` gains `consecutive_failures` and `next_attempt_at`, with an additive idempotent migration in `src/database.ts` and matching reads and writes in `src/repository.ts`.
- Customer-facing source wording in `public/app.js`.
- Login, credential storage, reply generation, delivery, Funnel integration and the Partner API contracts are unchanged.
