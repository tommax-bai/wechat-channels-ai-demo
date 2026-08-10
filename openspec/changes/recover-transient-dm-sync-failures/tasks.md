## 1. Retryable Cursor Classification

- [x] 1.1 Replace the three direct-message cursor reads with a shared `requiredCursor` helper that rejects absent and blank values as `dm_cursor_unavailable`, names the observed top-level response keys in the message, and records no response value.
- [x] 1.2 Keep the recognized cursor field names at `cookie` and `nextCursor`, and keep every other direct-message field assertion on its existing `schema_changed` path.

## 2. Persisted Bounded Retry

- [x] 2.1 Add `consecutive_failures` and `next_attempt_at` to `source_states` through the existing idempotent additive column check, and surface both through `SourceRow`.
- [x] 2.2 Require both fields on every `updateSource` write so a caller cannot silently inherit stale pacing.
- [x] 2.3 Count consecutive failures on failure, clear them on success, and compute the next attempt as the lane cadence for retryable failures or 5 minutes for `schema_changed`, doubled per consecutive failure and capped at 30 minutes.
- [x] 2.4 Skip a source whose persisted next-attempt time is still in the future, and let the superseded comment cursor recovery bypass that gate.

## 3. Remove The Terminal Direct-Message Branch

- [x] 3.1 Delete the direct-message `schema_changed` dead end so a schema failure backs off instead of ending the lane, and keep the comment cursor recovery running first with its baseline reset.
- [x] 3.2 Verify a recovered source needs no fresh QR scan and keeps its retained inbox rows.

## 4. Diagnostics And Customer Wording

- [x] 4.1 Log every source failure with source, masked session, code, consecutive failure count and next retry delay, and log the recovery when a previously failing source succeeds.
- [x] 4.2 Reword the customer-facing source states so a retrying failure does not claim the platform interface changed, and say the baseline is incomplete rather than only that automatic replies are off.

## 5. Regression Validation

- [x] 5.1 Cover a blank login cookie becoming a retryable failure that recovers on a later tick, a direct-message `schema_changed` retrying after its backoff, backoff growth and cap, clearing on success, and pacing surviving a restart.
- [x] 5.2 Run lint, typecheck, the complete test suite, build, and `openspec validate recover-transient-dm-sync-failures --strict`.

## 6. DEV Delivery And Live Acceptance

- [x] 6.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health plus the new columns.
- [ ] 6.2 Verify on DEV that a newly scanned account survives the login-cookie race, and that a source forced into `schema_changed` retries on schedule instead of staying silent.

Incident evidence (2026-08-10): the retained account `3jxpLR…` recorded `schema_changed:data.cookie` on its direct-message source at 19:10:02, ten seconds after its scan completed, and made no further attempt for fifty minutes while its comment source kept synchronizing every minute. A read-only probe using that account's stored credentials showed the contract intact: `get-history-msg` returned `msg`, `baseResp.errcode=0`, `isContinue=false` and a 24-character `cookie`, and `get-login-cookie` returned an 8-character `cookie`. The probe printed key names, types and lengths only, and was removed from the host afterwards. The account was recovered without a rescan by resetting only that one source row to `pending`; it completed its baseline at 20:34:17 and stored its single historical direct message as `historical=1`, `reply_eligible=0`.

Test evidence: 159 tests pass, and three mutations each turned red only the case written for them — removing the retry gate failed the transient-retry and restart-pacing cases, restoring the terminal direct-message branch failed the schema-retry case, and reverting the cursor classification to `schema_changed` failed both blank-cursor cases.

DEV delivery evidence (2026-08-10): commit `4d2c24d` was fast-forwarded into the standalone `main` and installed as `/opt/wechat-channels-ai-demo/releases/4d2c24d` using Alibaba Cloud's npm mirror, passing the complete server-side check with 159 tests before activation. The previous release pointer (`releases/3ba9580`), the root-owned environment and unit, and a WAL-consistent SQLite backup with `quick_check=ok` are retained together at `/opt/wechat-channels-ai-demo/backups/pre-4d2c24d-20260810T130758Z`. Only `wechat-channels-ai-demo.service` was restarted; it returned `active` with `NRestarts=0`, local health and readiness returned 200, `https://dev.yytt.com.cn/healthz` returned 200, both new columns are present, the live database passed `quick_check`, and `nginx`, `aidcp-cloud` and the four `isales*` units kept their pre-deploy states and restart counts. After activation both lanes of the recovered account continued healthy with zero consecutive failures.

Task 6.2 stays open on purpose. The login-cookie race can only be observed on a fresh scan, and forcing a live account into `schema_changed` to watch its 5-minute retry would degrade a real account's lane for that window; neither belongs in an unattended deployment step. The behaviour is covered by mutation-verified tests, and this item is the live confirmation to run on the next new account.
