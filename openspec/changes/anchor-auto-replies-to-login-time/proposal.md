## Why

Reply eligibility currently approximates "never answer content from before this account was connected" with three stacked brakes: everything found during a baseline is historical, anything older than the newest stored item for the source is historical (the watermark), and anything first seen more than 6 hours after it arrived is historical (the age cap).

The watermark anchors on the wrong thing. It compares against the newest stored item *anywhere in the source*, so an item that arrived after login — genuinely new, genuinely unanswered — is silenced whenever any other conversation or post has produced something newer. A direct message arriving while the baseline is still walking pages is silenced by the baseline rule for the same reason: the brakes gate on *how* the item was discovered, not on *when it happened*. Today these gaps are edge cases. With the planned backward comment sweep over up to 100 posts, "first scan of a post that already has post-login comments" becomes a routine event, and the watermark would routinely misclassify answerable comments as historical.

The intent has a direct expression: the login success time. Content from before the operator connected the account is backlog; content from after is theirs to answer.

## What Changes

- Persist the login success time on the demo session, stamped every time authentication completes. A re-scan after expiry stamps the new login time; the anchor always reflects the current authorization.
- Replace reply eligibility with one rule: a first-seen item is reply eligible when it occurred at or after the current login success time and within the maximum automatic-reply age of 6 hours. The watermark is removed, and baseline discovery no longer forces an item historical — an item that arrived after login is answerable even when the baseline or a first post scan is what surfaced it.
- Backfill retained sessions with the migration moment as their anchor, so the cutover itself can never emit a burst of replies to pre-existing content.
- Deduplication by immutable platform ID, the 6-hour age cap, and all synchronization pacing are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wechat-inbound-sync`: reply eligibility anchors on the current authorization's login-success time instead of the reply watermark and baseline-historical rules; the age cap remains the bound on backlog blasts.

## Impact

- `src/database.ts`: one additive column on `demo_sessions` holding the login-success timestamp, backfilled with the migration time for retained rows.
- `src/repository.ts`: `completeAuthentication` stamps the login time; `latestInboundOccurredAt` (the watermark read) is removed.
- `src/service/workers.ts`: `persistPage` gates on the login anchor and age cap only; `syncSource` stops computing the watermark.
- Tests: watermark cases are replaced by login-anchor cases; age-cap cases stay.
- Synchronization cadence, pagination, cursors, send path, and the Partner API are unchanged.
