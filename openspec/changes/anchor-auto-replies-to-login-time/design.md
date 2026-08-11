## Context

An item stored by `persistPage` is forced historical today for any of three reasons: its source baseline is not complete, it is older than the newest item already stored for that source, or it was first seen more than 6 hours after it arrived. The first two are proxies for "this existed before the operator connected the account", built from what the lane happens to have stored rather than from the event they approximate.

The proxies over-block in ways an operator can observe:

- A direct message arriving while the baseline is still walking history pages is stored as historical and never answered, even though it arrived after login.
- A comment posted after login on a post the scanner reaches later is blocked by the watermark whenever another post has produced a newer comment first — which is the common case, not the rare one, once the backward sweep over up to 100 posts exists.

The operator has decided the rule these proxies were reaching for: **not seen before + occurred at or after this login + within 6 hours → answer; everything else is stored and displayed as historical.** "This login" means the current authorization's login-success time: a re-scan after expiry moves the anchor forward.

## Goals / Non-Goals

Goals:
- Anchor reply eligibility on the login event itself, so eligibility depends on when the item happened, not on which scan surfaced it.
- Keep the cutover silent: deploying this change must not answer anything that the previous rules would have kept historical.
- Keep the backlog blast radius bounded when a lane recovers from being blind.

Non-Goals:
- Changing synchronization cadence, pagination, cursor formats, or the send path.
- Tuning the 6-hour age cap. It stays a single named value.
- Answering pre-login backlog. Content from before the anchor stays visible for a human, never auto-answered.

## Decisions

**The anchor is the current authorization's login-success time.** It is stamped in `completeAuthentication`, the single point every successful login funnels through, and persisted on the session row so restarts keep it. A re-scan after expiry stamps the new time — the operator chose this over preserving the first-ever login: messages that arrived while the account was logged out are stored as historical rather than answered late. The age cap would have bounded that exposure anyway; resetting the anchor makes the behavior uniform instead of dependent on how long the logout lasted.

**The watermark and the baseline's reply-gating role are removed, not weakened.** Eligibility is one comparison against the anchor plus the age cap. The baseline keeps its other jobs — pagination, source health, the comment observation marker — but discovery path no longer decides eligibility. This deletes the watermark read (`latestInboundOccurredAt`) and the `baselineHistorical` branch rather than layering a fourth rule on top of three.

**Retained sessions are backfilled with the migration moment.** A retained row has no recorded login time and its true one is unknowable. Backfilling with the migration time makes everything already in flight historical at cutover — exactly what the old rules would have concluded — and new content is eligible from the first post-deploy poll. Backfilling with anything earlier could answer old content on deploy; leaving it null would silence retained accounts until their next re-scan.

**Timestamps are trusted as they are today.** Platform event times are compared against this service's clock for both the anchor and the age cap; skew of a few seconds around the login moment is accepted. An item whose platform timestamp cannot be parsed is treated as arriving now — the pre-existing convention — and passes both gates; the watermark never caught that case either, since "now" exceeds any stored watermark.

## Risks / Trade-offs

- Messages arriving during a logout gap are never auto-answered once the operator re-scans. Accepted by decision; they remain visible as historical.
- A lane blind for less than 6 hours still answers its whole missed window on recovery, exactly as today. The age cap remains the only bound; removing the watermark does not widen it, because anything the watermark would have blocked inside that window was by definition unseen post-login content — which the operator wants answered.
- First scan of a post in the future backward sweep answers post-login comments up to 6 hours old in one pass. That is the intended behavior of this rule; the sweep's own design must still pace how many posts are first-scanned per interval.
- The anchor lives on the session row, not per source. Both sources share one login event; a per-source anchor would reintroduce the coupling this change removes.

## Migration Plan

Forward: one additive column with a backfill in the existing migration path. No cursor or credential changes.

Backward: the previous build ignores the new column, and its watermark rebuilds itself from stored rows on the next poll. Rolling back restores the old gating with no statement to run.
