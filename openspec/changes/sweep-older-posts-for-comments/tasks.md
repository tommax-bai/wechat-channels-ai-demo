## 1. Persist Sweep State

- [x] 1.1 Add nullable `sweep_rank` and `sweep_attempt_at` columns to `source_states` with no backfill.
- [x] 1.2 Expose both on the source row and add the attempt-mark and rank-advance repository writes, attempt marked before dispatch.

## 2. Sweep Step

- [x] 2.1 Add the `sweepComments` gateway method: one post-list page (size 10) locating the target rank, one comment page for that post, wrap signalling when the feed ends before the rank; an empty page wraps instead of raising.
- [x] 2.2 Drive the sweep from the comment lane's heartbeat behind its own durable 90-second gate, inside the per-account platform-session lock, only after the baseline is complete and while the lane is healthy.
- [x] 2.3 Route sweep failures through the extracted shared failure recorder so both comment lanes share one state and one backoff schedule.

## 3. Regression Validation

- [x] 3.1 Cover the request shape per step, rank advance, wrap at 100 and at a short feed, the 90-second gate across restarts, shared backoff on sweep failure, and anchor gating of swept items (pre-login historical, post-login answered).
- [x] 3.2 Run lint, typecheck, the complete test suite, build, and `openspec validate sweep-older-posts-for-comments --strict`.

Test evidence (2026-08-11): 174 tests pass (5 new) with lint, typecheck, build and strict validation clean. The failure-path case proves a sweep error lands on the comment source with the 60-second comment floor, pauses both lanes, leaves the rank unadvanced, and retries the same rank on the first due sweep after the fast scan recovers the lane.

## 4. DEV Delivery And Live Acceptance

- [x] 4.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health.
- [x] 4.2 Verify on DEV that sweeps advance on the 90-second schedule, request volume stays within budget, and no swept pre-login backlog produces replies.

DEV delivery evidence (2026-08-11): commit `a0b7bdc` was installed as `/opt/wechat-channels-ai-demo/releases/a0b7bdc` using Alibaba Cloud's npm mirror and passed the complete server-side check with 174 tests before activation. The previous release pointer (`releases/f7b6f4d`), the root-owned environment, the unit file, and a WAL-consistent SQLite backup with `quick_check=ok` are retained at `/opt/wechat-channels-ai-demo/backups/pre-a0b7bdc-20260811T061819Z`. Only the demo unit was restarted; it returned `active` with `NRestarts=0`, local health and readiness returned 200, `https://dev.yytt.com.cn/healthz` returned 200, the live database passed `quick_check`, and both sweep columns were present after migration.

Live acceptance (2026-08-11, task 4.2): the first sweep step ran with the first post-restart tick at 14:19:27 CST and surfaced one old post's comment page holding five comments — four from August 8–9, before the login anchor, stored as historical with no reply job, and one fresh comment from 13:55, post-login and 24 minutes old, answered with a platform-confirmed reply. That single step demonstrates both halves of the design: swept backlog stays silent, swept news is answered. Healthy accounts then kept sweeping on the 90-second schedule (observed attempt ages advancing between checks) and accounts with three or fewer posts wrapped at rank 4 each step. The service logged zero synchronization failures, and the reply-job total moved 15→16 across the cutover — exactly the one sweep-discovered fresh comment. One comment source shows a stale healthy state with no sweep because its session is `auth_required`; sessions excluded from synchronization are correctly excluded from sweeping.
