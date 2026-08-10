## Context

Comment synchronization currently treats each post or comment continuation as a separate page. Every page begins by fetching the same post-list page again so the durable cursor can prove that its bound post has not moved. With a 15-second worker tick and a 10-page inner loop, multi-post accounts generate many redundant reads. DEV evidence showed retained identities with positive `feedsCount` receiving `errCode=0` and an empty post list after hundreds of successful pages; the cursor then entered a permanent `schema_changed:post.cursor_target_missing` state.

The requested Demo policy deliberately trades breadth and latency for a smaller, stable request shape: one post-list read every 60 seconds, the first 3 posts only, and one comment-list read per selected post.

## Goals / Non-Goals

**Goals:**

- Make one bounded comment scan per account no more often than every 60 seconds.
- Fetch the post list once per scan and issue at most 3 comment-list reads.
- Keep direct-message timing unchanged.
- Preserve stable-ID deduplication and exact reply targets.
- Recover the observed cursor failure without making previously unseen historical comments reply eligible.
- Keep a previously non-empty account visibly unavailable when the platform returns a successful-but-empty post list.

**Non-Goals:**

- Reading posts after the first 3, following post pagination, or following comment pagination.
- Increasing comment freshness beyond the one-minute policy.
- Changing login, direct messages, reply generation, Funnel behavior, or platform send semantics.
- Claiming a private WeChat endpoint is stable or diagnosing an undocumented platform throttle from an empty response alone.

## Decisions

### Schedule direct messages and comments independently

The worker keeps its existing configured sync timer for direct messages and adds a five-second local heartbeat that only checks whether a comment source is due. A durable per-source `last_attempt_at` timestamp is written before dispatch and the gateway is called only after 60 seconds have elapsed, so a process restart or a long scan crossing a timer boundary cannot issue another comment read for the same account inside 60 seconds. The shorter local heartbeat avoids the timer-anchor drift that would otherwise turn a fast one-minute scan into an accidental two-minute cadence; it does not make additional WeChat requests. Existing comment rows backfill the attempt timestamp from their last source update when they contain prior-attempt evidence. A newly created source that has never attempted a baseline, and a source recovered in the current worker pass, may start immediately. Each source has an independent re-entrancy guard, while the existing per-account platform-session lock serializes cookie-bearing reads across both timers. This keeps direct messages independent without adding a deployment knob.

### Make one gateway call represent one complete bounded comment scan

`syncComments` will request post page 1 once with a page size of 3, validate and select at most 3 identities, then sequentially request one comment page with an empty comment cursor for each selected post. It returns all normalized items as one page with `hasMore=false`; post and comment continuation markers are intentionally ignored.

Sequential reads reuse one cloned cookie jar and avoid concurrent mutation of the same platform session. Existing immutable external IDs continue to deduplicate comments observed on every minute scan.

### Replace the pagination cursor with a non-pagination observation marker

The comment cursor no longer selects a post or comment continuation. A versioned marker records whether this account has ever produced a non-empty post list. Any structurally valid persisted v2 post cursor is read as evidence that posts were previously observed, including a cursor whose current page snapshot is empty after advancing beyond page 1. The previous worker encrypted a completed cursor as `null` for both empty and non-empty scans, so a retained source with a completed baseline and that ambiguous legacy value is conservatively migrated as previously observed. A genuinely empty account becomes distinguishable after its first new bounded scan persists an explicit v3 `observedPosts=false` marker.

When an account first returns a non-empty post list, the worker durably checkpoints the observation marker before the gateway dispatches any comment-list request. A later comment-list failure therefore cannot lose the evidence and cannot let an intervening empty post list complete a false empty baseline.

If a previously non-empty account returns an empty list, the gateway raises a retryable `platform_post_list_empty` error instead of reporting a healthy zero-item scan. A genuinely empty new account can complete a zero-item baseline and will begin scanning normally when it publishes a post.

### Recover only the observed superseded cursor failure as historical baseline

When a retained comment source has exactly `schema_changed:post.cursor_target_missing`, the worker atomically changes that source to `pending` with `baseline_complete=false` while retaining its encrypted cursor marker and existing inbox rows. The immediately attempted bounded scan therefore persists any unseen items as historical and creates no reply jobs. Once that scan succeeds, later unseen comments are eligible under the existing automation contract.

Other schema errors remain fail-closed because this change has no evidence that they share the same cause.

## Risks / Trade-offs

- [Comments on posts after the first 3 or beyond the first comment page are not observed] → This is the explicit bounded Demo policy requested by the operator and is covered by contract tests.
- [A platform empty-list response can persist after request volume is reduced] → Keep the source in retryable error, retry only every 60 seconds, and report the live result without fabricating recovery.
- [Rollback code cannot understand the new cursor marker] → Back up the DEV database before deployment; rollback restores both the previous release and its database backup.
- [A recovery scan contains old unseen comments] → Reset only the comment baseline flag, retain existing inbox rows, and mark every newly discovered recovery item historical.

## Migration Plan

1. Back up the DEV SQLite database and environment before release activation.
2. Deploy the compatible reader for both old v2 cursors and the new bounded-scan marker.
3. Let the worker recover only sources with the observed `post.cursor_target_missing` code and run one historical bounded scan.
4. Verify request counts, source state, timestamps, newly visible comments, and absence of reply jobs created from the recovery baseline.
5. If validation fails, restore the previous release and the pre-deployment database backup.

## Open Questions

None.
