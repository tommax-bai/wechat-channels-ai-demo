## Context

The comment lane makes one bounded scan per account per 60 seconds: one first-page post-list read (page size 3) and one first-page comment read per post. The bound exists because the previous unbounded traversal re-fetched the post list before every comment page and was eventually answered with successful-but-empty post lists — the platform's soft refusal. Posts beyond the first 3 are never read.

The login-time anchor now decides reply eligibility from when an item happened, not from which scan surfaced it. That removed the last piece of per-post state a deeper scan used to need: there is no per-post baseline to manage, so reading an old post for the first time is safe by construction — its pre-login comments are stored as historical, and its post-login comments within the age cap are genuinely answerable.

## Goals / Non-Goals

Goals:
- Cover posts 4 through 100 on a cadence slow enough to be invisible in the request budget.
- Keep one full pass well under the 6-hour reply window, so swept discoveries are still answerable.
- Keep one health state per comment source: a throttled account slows both lanes together.
- Survive restarts without re-sweeping from the top or sweeping early.

Non-Goals:
- Prioritizing newer ranks inside the sweep. Uniform 90-second steps first; layering can come later if rank-4 latency matters.
- Following comment continuations on swept posts. One first page per visit, like the fast lane.
- Detecting soft-throttling from inside the sweep. The fast lane owns the observation marker and stays the honest empty-list detector.

## Decisions

**Rank-addressed, not snapshot-addressed.** Each step fetches the post-list page that currently contains the target rank (page size 10, `currentPage = ceil(rank / 10)`) and reads the post at that offset. No post inventory is cached: posts move between pages as new ones publish, and a rank-addressed step tolerates that drift — at worst a post is visited twice or skipped for one pass, which deduplication and the anchor absorb. A cached snapshot would trade those harmless misses for staleness bugs and a second kind of cursor. This costs one locating read per step; two requests per 90 seconds is ~1.3 per minute against the lane's existing 4.

**Post-list pagination is live-proven.** The pre-bound implementation walked post pages against production for hundreds of successful reads before its volume, not its request shape, became the problem. The sweep reuses that shape at one-hundredth the rate.

**Sweep state lives on the source row.** `sweep_rank` is the next rank to visit (null starts at 4); `sweep_attempt_at` is the durable 90-second gate, written before dispatch exactly like the fast lane's `last_attempt_at`, so a restart cannot produce an early or duplicate step. The rank advances only after a successful step; a crash between attempt and advance revisits one post, which is harmless. The comment cursor keeps its v3 observation-marker format untouched.

**One failure path.** A sweep error is recorded by the same failure recorder as a fast-scan error: same state transitions, same persisted exponential backoff, same `auth_required` demotion. The backoff gate at the top of the lane then paces both lanes together — if the platform is refusing this account, the correct response is for the whole comment lane to slow down, not for the sweep to keep probing.

**Emptiness ends the pass instead of raising.** If the located page holds no post at the target offset, the feed ends before the rank: the sweep wraps to rank 4 and the step completes without a comment read. An empty first page in the sweep also just wraps — the fast lane, which holds the observation marker, is the component that can honestly distinguish a genuinely empty account from a soft-throttled one, and it already raises `platform_post_list_empty`. Duplicating that judgment here without the marker would misclassify empty accounts.

**Eligibility is the anchor's job.** Swept items go through the same `persistPage` as everything else. No sweep-specific reply rules exist: first visit to a post with a fresh post-login comment answers it, and a first visit surfacing years of backlog stores it as historical. The 97-step pass takes ~2.4 hours, inside the 6-hour cap, so the sweep's own latency never reclassifies an answerable comment.

## Risks / Trade-offs

- A comment on a swept post is discovered up to one full pass (~2.4 hours) late. Accepted: the alternative was never. Growing the rank bound or slowing the cadence must keep one pass under 6 hours, or old-post comments become permanently historical.
- On accounts with 3 or fewer posts the sweep spends one locating read per 90 seconds discovering there is nothing to sweep. Accepted for simplicity; it is the cost of not caching feed size, and it stops the moment a fourth post publishes.
- First sweep of an active old post can answer several post-login comments in one step. Bounded by the age cap to a 6-hour window per post, and steps are 90 seconds apart, so the send lane's serial pacing holds.
- Two more nullable columns on `source_states`. Additive; the previous build ignores them.

## Migration Plan

Forward: two nullable columns, no backfill. Every retained comment source starts its first sweep at rank 4, immediately due.

Backward: the previous build ignores the columns and never sweeps. No statement to run.
