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

- [ ] 4.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health.
- [ ] 4.2 Verify on DEV that sweeps advance on the 90-second schedule, request volume stays within budget, and no swept pre-login backlog produces replies.
