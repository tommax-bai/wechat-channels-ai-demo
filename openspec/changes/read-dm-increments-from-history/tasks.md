## 1. Read Increments From The Proven Endpoint

- [x] 1.1 Read every direct-message poll from the history endpoint, keeping baseline pagination and reading only the first page once the baseline is complete.
- [x] 1.2 Stop calling the notify and login-cookie endpoints from the synchronization path, and drop the now-meaningless `dmCursor` field from the platform session.
- [x] 1.3 Migrate a retained v1 cursor on read: keep its phase, discard its token, and never replay it against a different endpoint.

## 2. Reply Eligibility Brakes

- [x] 2.1 Add a reply watermark from the newest stored item for the source, and store anything older as historical.
- [x] 2.2 Add a 6-hour maximum automatic-reply age so a recovered blind lane cannot answer a backlog at once.
- [x] 2.3 Keep both brakes out of the baseline path, where every item is historical already.

## 3. Regression Validation

- [x] 3.1 Cover the baseline walking pages and then re-reading only the first page, a retained notify cursor still reading history, the watermark blocking an older unseen item, and the age cap blocking a stale one.
- [x] 3.2 Replace the tests that covered the retired notify and login-cookie path rather than leaving them asserting code that no longer runs.
- [x] 3.3 Run lint, typecheck, the complete test suite, build, and `openspec validate read-dm-increments-from-history --strict`.

## 4. DEV Delivery And Live Acceptance

- [x] 4.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health.
- [x] 4.2 Verify on DEV that the account whose message was missed now stores it and answers it, and that no other account emits a burst of replies to old content.

Diagnosis evidence (2026-08-10): account 星禾2806 held a healthy direct-message source that polled successfully every 15 seconds for an hour and stored nothing. A read-only probe with its stored credentials showed the history endpoint returning two messages — the newest an inbound text at 21:27:12 that was not stored — while the notify endpoint returned zero messages both with the lane's stored cursor and with a cursor issued seconds earlier. The probe printed key names, types and lengths only and was removed from the host. Direct-message inboxes across every account had been frozen since mid-morning while comment lanes kept discovering content.

Test evidence: 161 tests pass, and three mutations each turned red only the cases written for them — disabling the watermark failed the already-seen-era case, disabling the age cap failed the long-delayed case, and sending incremental reads back to the notify endpoint failed both endpoint-selection cases. The age-cap case initially survived its mutation because the watermark blocked the reply first; the baseline item is now aged past the cap so the two brakes are tested independently (`4537aff`).

DEV delivery evidence (2026-08-10): commit `4537aff` was fast-forwarded into the standalone `main` and installed as `/opt/wechat-channels-ai-demo/releases/4537aff` using Alibaba Cloud's npm mirror, passing the complete server-side check with 161 tests before activation. The previous release pointer (`releases/4d2c24d`), the root-owned environment and unit, and a WAL-consistent SQLite backup with `quick_check=ok` are retained at `/opt/wechat-channels-ai-demo/backups/pre-4537aff-20260810T140500Z`. Only the demo unit was restarted; it returned `active` with `NRestarts=0`, local health and readiness returned 200, `https://dev.yytt.com.cn/healthz` returned 200, and `nginx` and the `isales*` units kept their pre-deploy states.

Live acceptance (2026-08-10, task 4.2): within one polling interval of activation, 星禾2806 discovered the 21:27 message at 22:09:05 as non-historical and reply-eligible, and its reply job reached `confirmed` at 22:09:14 — the platform acknowledged the automatic reply. No other account produced any reply: their stored direct-message counts were unchanged (1, 11, 23 and 3 rows), so the switch to a window read emitted no backlog burst. Both of that account's sources stayed healthy with zero consecutive failures and the service logged no synchronization failure after the restart.
