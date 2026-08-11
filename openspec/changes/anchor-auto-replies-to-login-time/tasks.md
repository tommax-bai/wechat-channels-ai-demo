## 1. Persist The Login Anchor

- [x] 1.1 Add the login-success timestamp column to `demo_sessions`, backfilled with the migration time for retained rows.
- [x] 1.2 Stamp the anchor in `completeAuthentication` so every successful login — first scan or re-scan — moves it to the current moment.
- [x] 1.3 Expose the anchor on the session row read by the workers.

## 2. Replace The Eligibility Rule

- [x] 2.1 Gate `persistPage` on "occurred at or after the anchor, within the 6-hour age cap" and delete the `baselineHistorical` and watermark branches, updating the comment that explains the brakes.
- [x] 2.2 Remove the watermark read (`latestInboundOccurredAt`) and the watermark computation in `syncSource`.
- [x] 2.3 Keep deduplication, the age cap, `automationEnabled`, and `authState` conditions unchanged — widened only so `baseline_sync` stores eligibility for a post-login item surfaced mid-baseline, since deduplication means no later poll will offer it again; dispatch still waits for the session to become active.

## 3. Regression Validation

- [x] 3.1 Replace watermark tests with anchor cases: a pre-login item stays historical; a post-login item older than the source's newest stored item is answered; a post-login item surfaced during an incomplete baseline is answered; a re-scan moves the anchor so logged-out-gap items stay historical.
- [x] 3.2 Keep the age-cap case independent of the anchor, as the watermark-era mutation testing required. The anchor is backdated 8 hours in that case so the 7-hour-old item is post-login and only the cap holds it.
- [x] 3.3 Verify the backfill: a retained row gets the migration time and its pre-deploy content stays historical on the first post-deploy poll; a never-authenticated row keeps a null anchor until its first login.
- [x] 3.4 Run lint, typecheck, the complete test suite, build, and `openspec validate anchor-auto-replies-to-login-time --strict`.

Test evidence (2026-08-11): 169 tests pass with lint, typecheck, build and strict validation clean. Two mutations each turned red only what was written for them: disabling the login anchor failed 21 cases (every baseline-historical and pre-login assertion), and disabling the age cap failed exactly the long-delayed case — the two brakes are independently tested. The fake gateway now stamps its baseline item one minute pre-login so the anchor, not the age cap, is what makes fixture history historical.

## 4. DEV Delivery And Live Acceptance

- [x] 4.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health.
- [x] 4.2 Verify on DEV that no retained account emits any reply at cutover, and that a fresh post-login message is answered within one polling interval.

DEV delivery evidence (2026-08-11): commit `f475cac` was installed as `/opt/wechat-channels-ai-demo/releases/f475cac` using Alibaba Cloud's npm mirror and passed the complete server-side check with 169 tests before activation. The previous release pointer (`releases/beac7b3`), the root-owned environment, the unit file, and a WAL-consistent SQLite backup with `quick_check=ok` are retained at `/opt/wechat-channels-ai-demo/backups/pre-f475cac-20260811T053033Z`. The root-owned environment's `SYNC_POLL_MS` and `WECHAT_TIMEOUT_MS` moved from 15000 to 30000 as part of this delivery. Only the demo unit was restarted; it returned `active` with `NRestarts=0`, local health and readiness returned 200, `https://dev.yytt.com.cn/healthz` returned 200, and `nginx` and the `isales*` units kept their pre-deploy states.

Cutover acceptance (2026-08-11, task 4.2): the migration stamped all 5 authenticated retained rows with the migration moment and left both never-authenticated rows null, with `quick_check=ok` on the live database. Across the cutover and a 100-second observation window (three polls at the new 30-second direct-message cadence), the reply-job count stayed 13→13, stored inbound counts stayed 42 direct messages and 34 comments, every source kept its pre-deploy state (3 healthy, 2 auth_required, 2 pending per lane) with zero consecutive failures, and the service logged no synchronization failure. The newest healthy direct-message success timestamp advanced 60 seconds across a 65-second window — two polls, confirming the 30-second cadence. No organic inbound message arrived during the window, so the answered-within-one-interval half rests on the contract tests until the next real message; the cutover half — no burst of replies to pre-existing content — is proven live. After acceptance completed, `current` moved to `f7b6f4d` — a direct child of `f475cac` that changes only the default recruitment job number and carries this change's code unchanged — as part of a parallel delivery; the final switch and restart were executed by the operator. Verified after that handoff: the unit stayed `active` with `NRestarts=0`, health returned 200, the migration skipped idempotently with no repeated backfill, and the environment kept the 30-second values.

Live anchor evidence (2026-08-11): at 13:37:34 CST an account completed a fresh scan on the new release, and its baseline walk at 13:37:48 surfaced 11 direct messages dating from August 8–10 — all stored as historical with `reply_eligible=0` and zero reply jobs created. The login anchor classified a real pre-login backlog correctly on its first live encounter. The reply-job total moved 13→11 in the same window solely because an expired transient session was routinely cleaned up, deleting its two retained jobs by cascade; no job was created after the cutover. The answered-within-one-interval scenario for a fresh post-login message still awaits the next organic inbound message under the new rule; the last such live proof (17 seconds from arrival to platform-confirmed reply) ran minutes before this cutover on the previous release.
