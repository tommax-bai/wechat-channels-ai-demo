## Context

The direct-message lane had two phases. The baseline paged through the history endpoint until the platform stopped reporting continuations. It then called the login-cookie endpoint once, took the token it returned, and switched permanently to the notify endpoint, rolling that token forward from each response.

Live evidence gathered on 2026-08-10 with one account's stored credentials:

- history endpoint: two messages, the newest an inbound text at 21:27:12 that was not stored;
- notify endpoint with the lane's stored cursor: zero messages;
- notify endpoint with a cursor issued seconds before the call: zero messages.

So the missing message is not a parsing problem, not a cursor problem, and not an authentication problem. The channel the lane reads does not carry it. The notify endpoint's request shape was derived from the official front-end bundle and never confirmed against live traffic; the history endpoint has been confirmed since the first working baseline.

## Goals / Non-Goals

Goals:
- Read direct messages from the channel that demonstrably carries them.
- Keep a successful read from meaning "nothing arrived" when the caller has not actually looked where messages are.
- Never turn the switch into a burst of automatic replies to content that is not new.

Non-Goals:
- Reverse-engineering the notify endpoint's real parameters. It may well work with arguments this service does not send, but a channel whose silence is indistinguishable from an empty mailbox is not one to build on without live proof.
- Changing comment synchronization, which was never affected.
- Following history continuations after the baseline. One page per poll is enough at this cadence and keeps the request budget flat.

## Decisions

**One endpoint, two phases.** The baseline still walks pages with the platform's continuation cookie. After it completes, each poll re-reads the first page with no cookie — the same request the very first baseline read makes. Deduplication by immutable message ID already exists and is what makes the repeated overlap harmless; it was observably working before this change, correctly recognizing an older message as already stored.

**The incremental phase carries no platform cursor.** Its cursor payload now records only that the baseline is behind us. A retained v1 incremental cursor migrates to that state and its token is discarded rather than replayed against a different endpoint. Keeping a token that addresses an abandoned channel would be a value nothing can interpret.

**Reply eligibility gets two independent brakes.** Reading a window rather than a strict delta means a read can surface items that are not new, so eligibility now requires both:
- the item is not older than the newest already-stored item for that source (the watermark), and
- the item arrived within the last 6 hours (the age cap).

The watermark comes from the stored inbox rather than from a separate record, so it needs no migration and repairs itself: whatever the lane stores becomes the next watermark. The age cap exists because this class of bug ends with a lane that has been blind for a long time suddenly seeing everything; answering a whole backlog at once is worse than showing it to a human. Normal traffic is discovered within one polling interval and is unaffected by either brake.

**The notify and login-cookie descriptors stay defined.** Deleting them would erase the record of what was tried. They are simply not called.

## Risks / Trade-offs

- Re-reading the first page every poll returns items already stored. That is one request per account per interval, the same budget as before, and the unique external-ID index absorbs the repeats.
- If more new messages arrive between two polls than one history page holds, the surplus is not fetched in that poll. At a fifteen-second cadence this needs a burst larger than a page within one interval; the next poll still sees whatever remains on the first page, and the baseline path is the one that handles bulk.
- An item whose platform timestamp cannot be parsed is treated as arriving now, which is the pre-existing convention. Such an item passes the age cap. It still has to pass the watermark.
- The 6-hour cap is a policy number, not a discovered constant. It is a single named value so it can be tuned once the operator has a view on how late an automatic reply is still welcome.

## Migration Plan

Forward: nothing to run. The retained cursor is migrated on read and no table changes.

Backward: a v2 cursor is not readable by the previous build, which rejects it as a schema error on every attempt. Rolling back therefore needs one statement per affected deployment, resetting the direct-message sources to a fresh baseline:

```sql
UPDATE source_states SET cursor_envelope = NULL, state = 'pending', baseline_complete = 0
WHERE source = 'dm';
```

That re-runs the baseline, which stores nothing new — deduplication holds — and creates no reply jobs, because every item a baseline stores is historical. This is written down because the alternative, discovering it during a rollback, is exactly when nobody wants to be reading cursor formats.
