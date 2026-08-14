## MODIFIED Requirements

### Requirement: Incremental normalized inbox
After a source baseline is complete, the service SHALL poll bounded incremental data, normalize new inbound text items, and deduplicate them durably within the owning WeChat account, so that an item stored by any container that hosted the account is recognized by every later container. Each comment source SHALL be polled no more often than once every 60 seconds; one comment poll SHALL fetch the post list exactly once, select at most the first 3 posts, and fetch exactly one comment page for each selected post. Each comment source SHALL additionally advance a sweep over post ranks 4 through 100 no more often than once every 90 seconds; one sweep step SHALL fetch at most one post-list page and at most one comment page for the single post at the target rank, SHALL wrap to rank 4 after rank 100 or when the feed ends before the target rank, and SHALL persist its position and attempt time so a restart neither repeats nor advances the schedule early. Each direct-message poll SHALL read the first page of the platform's history endpoint and SHALL NOT follow its continuation. A failing source SHALL be retried on a persisted exponential schedule and SHALL NOT be permanently abandoned; a sweep failure SHALL share the comment source's failure state and schedule. Account history SHALL be removed when its account no longer has any session row, and when the account's holding session is explicitly deleted.

#### Scenario: Same platform item appears in multiple polls
- **WHEN** a direct message or comment with the same immutable external ID is observed repeatedly
- **THEN** the service stores one inbox item and creates at most one reply job

#### Scenario: Same platform item is re-offered after a container change
- **WHEN** the account re-logs in — in the same container or a new one — and a poll or baseline re-offers an item the account's ledger already stores
- **THEN** the service keeps the stored item with its existing reply record and creates no second row and no second reply job

#### Scenario: Account loses its last container
- **WHEN** no session row holds the account any longer — its container rebound to a different account, or an expired holder was cleaned up
- **THEN** the cleanup sweep removes the account's stored items and their reply records

#### Scenario: Legacy per-session rows are re-keyed at startup
- **WHEN** the service starts over a database whose inbound rows were deduplicated per session
- **THEN** before any sync worker polls, rows are attributed to their session's account and their dedup hashes re-keyed in the account namespace, rows without an owning account are dropped, and the re-key runs exactly once

#### Scenario: Authenticated account's own message is observed
- **WHEN** an item is authored by the authenticated Finder identity
- **THEN** the service displays it if useful but does not mark it reply eligible

#### Scenario: New inbound text appears after baseline
- **WHEN** an unseen text item authored by another user is first observed after its source baseline and passes the login-anchor and age conditions
- **THEN** the service records the exact source reply target and marks the item eligible for automatic reply

#### Scenario: Bounded comment poll runs
- **WHEN** a comment source becomes due after 60 seconds
- **THEN** the service issues one first-page post-list request and at most 3 first-page comment-list requests without following either continuation

#### Scenario: Sweep step visits one older post
- **WHEN** a comment source's sweep becomes due after 90 seconds and the feed holds a post at the target rank
- **THEN** the service issues one post-list page request locating that rank and one first-page comment-list request for that single post, stores its normalized comments under the same deduplication and login-anchor rules, and advances the persisted rank by one

#### Scenario: Sweep reaches the end of the feed or the rank bound
- **WHEN** the located post-list page holds no post at the target rank, or the sweep advances past rank 100
- **THEN** the service wraps the persisted sweep position to rank 4 without raising an error and without a comment-list request for the missing rank

#### Scenario: Service restarts between sweep steps
- **WHEN** the process restarts less than 90 seconds after a sweep attempt
- **THEN** the service waits until the persisted attempt time is 90 seconds old before the next sweep step, and resumes from the persisted rank

#### Scenario: Sweep step fails
- **WHEN** a sweep step's post-list or comment-list request fails
- **THEN** the service records the failure on the comment source with its persisted exponential backoff, and both the fast scan and the sweep wait out the same schedule

#### Scenario: Service restarts before the comment source is due
- **WHEN** a healthy or failed comment source was attempted less than 60 seconds before process startup
- **THEN** the service waits until that source is due before issuing its next post-list request

#### Scenario: Direct-message polling continues independently
- **WHEN** a comment source is waiting for its 60-second due time
- **THEN** the service continues polling the direct-message source at its configured interval

#### Scenario: Second-level comment is observed
- **WHEN** the comment response contains a text node under a top-level comment with a complete exact write context
- **THEN** the service creates a separate normalized item with the stable root ID, the current comment as parent, and a sanitized write context with no embedded child list

#### Scenario: One comment node lacks an exact write context
- **WHEN** one top-level or nested comment has a missing or wrong-typed reply-context field, or its context comment ID differs from the normalized target
- **THEN** the service skips that node without creating an item or irreversible reply target, continues validating sibling and child nodes independently, and does not degrade an otherwise valid comment page

#### Scenario: A source attempt fails repeatedly
- **WHEN** a source records consecutive failures
- **THEN** each retry waits at least the previous delay doubled, starting from that lane's normal cadence for a retryable failure and from 5 minutes for a `schema_changed` failure, and never exceeding 30 minutes

#### Scenario: A failing source succeeds again
- **WHEN** a source with recorded consecutive failures completes a successful synchronization
- **THEN** the service clears its consecutive failure count and next-attempt time and resumes that lane's normal cadence

#### Scenario: Retry pacing survives a restart
- **WHEN** the process restarts while a source is waiting out a backoff delay
- **THEN** the service honors the persisted next-attempt time instead of retrying immediately

#### Scenario: Direct-message source reports a schema change
- **WHEN** a direct-message source is in `schema_changed`
- **THEN** the service retries it on the schema backoff schedule, keeps it ineligible for automation until a success, and never requires a fresh scan to resume

#### Scenario: Superseded comment cursor recovery is still available
- **WHEN** a retained comment source holds `schema_changed:post.cursor_target_missing`
- **THEN** the service still resets it to an incomplete historical baseline on its next tick regardless of any pending retry delay
