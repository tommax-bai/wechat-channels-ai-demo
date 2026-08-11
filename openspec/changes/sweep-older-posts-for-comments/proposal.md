## Why

The bounded comment scan reads only the first 3 posts. That bound was the correct response to the unbounded traversal that once produced hundreds of redundant requests and ended in successful-but-empty post lists, but it leaves every older post permanently unwatched: a visitor who comments on the fourth-newest post is never seen, let alone answered. The operator wants older posts covered — up to the 100 newest — without giving back the request discipline the bound bought.

A slow sweep does that at a cost the platform cannot notice. One post every 90 seconds is two requests per step — one post-list page to locate the target, one comment page to read it — which covers ranks 4 through 100 in about two and a half hours per full pass. That is well inside the 6-hour automatic-reply window, so a comment on an old post is still discovered in time to answer, and the login-time anchor decides eligibility for swept content exactly as it does everywhere else: pre-login comments stay historical, post-login comments within the age cap are answered.

## What Changes

- Add a comment sweep lane beside the 60-second fast scan: no more often than every 90 seconds per account, it locates one post by rank — starting at rank 4, wrapping after rank 100 or at the end of the feed — and reads that post's first comment page.
- Persist the sweep position and the sweep attempt time on the comment source row, mirroring the durable 60-second gate, so a restart neither restarts the sweep from the top nor sweeps early.
- Route sweep failures through the comment source's existing persisted exponential backoff and its `auth_required` handling; the lane keeps one honest health state.
- Keep the fast scan, the observation marker, the comment cursor format, and all reply-eligibility rules unchanged; swept items flow through the same normalization, deduplication, and login-anchor gating as fast-scanned ones.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wechat-inbound-sync`: comment coverage extends beyond the first 3 posts through a bounded 90-second sweep over ranks 4–100, persisted per source and paced independently of the 60-second fast scan.

## Impact

- `src/wechat/client.ts`: a `sweepComments` gateway method issuing one post-list page read (page size 10) and at most one comment-list read for the single located post.
- `src/service/workers.ts`: sweep due-check, dispatch, and rank advance inside the existing comment lane, sharing the per-account platform-session lock and the extracted failure recorder.
- `src/repository.ts` / `src/database.ts`: two nullable `source_states` columns (`sweep_rank`, `sweep_attempt_at`) with no backfill — a null gate means the first sweep may start immediately at rank 4.
- Tests: sweep pacing across restarts, rank advance and wrap, request shape, shared backoff, and anchor gating of swept items.
- Direct messages, sending, login, and the Partner API are unchanged.
