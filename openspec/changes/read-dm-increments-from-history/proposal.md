## Why

A retained DEV account reported a healthy direct-message source, polled successfully every fifteen seconds for an hour, and stored nothing. An inbound text message that reached the platform at 21:27 was never seen. The account's comment lane kept discovering new content throughout.

Asking the platform directly with that account's stored credentials showed why. The history endpoint returned the message; the notify endpoint the lane actually polls returned an empty page — with the lane's stored cursor and again with a cursor issued seconds earlier. The notify endpoint's shape came from the official front-end bundle and was never confirmed against live traffic, while the history endpoint is live-proven. Every account is affected: direct-message inboxes across the deployment stopped at mid-morning while comments continued.

The failure mode is worse than an outage. A successful empty page and a genuinely empty mailbox are indistinguishable to the caller, so the lane reports healthy, the customer-facing status says the same, and nothing ever escalates. The service was answering "no new messages" to a question it was asking in the wrong place.

## What Changes

- Read direct-message increments from the history endpoint's first page instead of the notify endpoint, keeping the existing baseline pagination unchanged and relying on the existing immutable-ID deduplication for the overlap between reads.
- Retire the notify and login-cookie calls from the synchronization path, and drop the platform cursor the incremental phase used to carry; a retained v1 cursor migrates to the new phase without replaying its token.
- Add a reply watermark so a window read cannot answer content it merely re-observed: an item older than the newest already-stored item for that source is stored and displayed, never answered.
- Add a maximum automatic-reply age of 6 hours so a lane that was blind cannot wake up and answer an entire backlog at once; late items stay visible for a human instead.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wechat-inbound-sync`: replace the notify-driven direct-message increment with a bounded first-page history read, and require both the reply watermark and the maximum reply age before any first-seen item becomes eligible for an automatic reply.

## Impact

- Direct-message cursor handling and endpoint selection in `src/wechat/client.ts`; `PlatformSession` loses the now-meaningless `dmCursor` field.
- Reply eligibility in `src/service/workers.ts` and a new newest-stored-timestamp read in `src/repository.ts`.
- No schema change and no migration; the retained cursor format is migrated on read.
- Comment synchronization, login, credential storage, delivery and the Partner API are unchanged. The notify and login-cookie request descriptors stay defined but unused.
