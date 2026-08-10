## 1. Retryable Cursor Classification

- [ ] 1.1 Replace the three direct-message cursor reads with a shared `requiredCursor` helper that rejects absent and blank values as `dm_cursor_unavailable`, names the observed top-level response keys in the message, and records no response value.
- [ ] 1.2 Keep the recognized cursor field names at `cookie` and `nextCursor`, and keep every other direct-message field assertion on its existing `schema_changed` path.

## 2. Persisted Bounded Retry

- [ ] 2.1 Add `consecutive_failures` and `next_attempt_at` to `source_states` through the existing idempotent additive column check, and surface both through `SourceRow`.
- [ ] 2.2 Require both fields on every `updateSource` write so a caller cannot silently inherit stale pacing.
- [ ] 2.3 Count consecutive failures on failure, clear them on success, and compute the next attempt as the lane cadence for retryable failures or 5 minutes for `schema_changed`, doubled per consecutive failure and capped at 30 minutes.
- [ ] 2.4 Skip a source whose persisted next-attempt time is still in the future, and let the superseded comment cursor recovery bypass that gate.

## 3. Remove The Terminal Direct-Message Branch

- [ ] 3.1 Delete the direct-message `schema_changed` dead end so a schema failure backs off instead of ending the lane, and keep the comment cursor recovery running first with its baseline reset.
- [ ] 3.2 Verify a recovered source needs no fresh QR scan and keeps its retained inbox rows.

## 4. Diagnostics And Customer Wording

- [ ] 4.1 Log every source failure with source, masked session, code, consecutive failure count and next retry delay, and log the recovery when a previously failing source succeeds.
- [ ] 4.2 Reword the customer-facing source states so a retrying failure does not claim the platform interface changed, and say the baseline is incomplete rather than only that automatic replies are off.

## 5. Regression Validation

- [ ] 5.1 Cover a blank login cookie becoming a retryable failure that recovers on a later tick, a direct-message `schema_changed` retrying after its backoff, backoff growth and cap, clearing on success, and pacing surviving a restart.
- [ ] 5.2 Run lint, typecheck, the complete test suite, build, and `openspec validate recover-transient-dm-sync-failures --strict`.

## 6. DEV Delivery And Live Acceptance

- [ ] 6.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health plus the new columns.
- [ ] 6.2 Verify on DEV that a newly scanned account survives the login-cookie race, and that a source forced into `schema_changed` retries on schedule instead of staying silent.
