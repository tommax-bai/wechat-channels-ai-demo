## MODIFIED Requirements

### Requirement: Incremental normalized inbox
After a source baseline is complete, the service SHALL poll bounded incremental data, normalize new inbound text items, and deduplicate them durably within the owning demo session. Each comment source SHALL be polled no more often than once every 60 seconds; one comment poll SHALL fetch the post list exactly once, select at most the first 3 posts, and fetch exactly one comment page for each selected post. Each direct-message poll SHALL read the first page of the platform's history endpoint and SHALL NOT follow its continuation. A failing source SHALL be retried on a persisted exponential schedule and SHALL NOT be permanently abandoned.

#### Scenario: Same platform item appears in multiple polls
- **WHEN** a direct message or comment with the same immutable external ID is observed repeatedly
- **THEN** the service stores one inbox item and creates at most one reply job

#### Scenario: Authenticated account's own message is observed
- **WHEN** an item is authored by the authenticated Finder identity
- **THEN** the service displays it if useful but does not mark it reply eligible

#### Scenario: New inbound text appears after baseline
- **WHEN** an unseen text item authored by another user is first observed after its source baseline, is not older than the newest item already stored for that source, and arrived within the maximum automatic-reply age
- **THEN** the service records the exact source reply target and marks the item eligible for automatic reply

#### Scenario: Direct-message baseline completes
- **WHEN** the platform reports no further direct-message history pages
- **THEN** the service completes the baseline and every later poll reads the first history page with no continuation token, without contacting the notify or login-cookie endpoints

#### Scenario: Retained cursor points at the abandoned notify channel
- **WHEN** a direct-message source holds a cursor written by the previous notify-driven implementation
- **THEN** the service keeps its completed-baseline meaning, discards its token, and reads the history endpoint instead of replaying that token

#### Scenario: Bounded comment poll runs
- **WHEN** a comment source becomes due after 60 seconds
- **THEN** the service issues one first-page post-list request and at most 3 first-page comment-list requests without following either continuation

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

### Requirement: Automatic replies only for genuinely new content
A first-seen item SHALL become eligible for an automatic reply only when it is newer than or equal to the newest item already stored for its source and it arrived within the maximum automatic-reply age of 6 hours. An item failing either condition SHALL be stored and displayed as historical, SHALL create no reply job, and SHALL NOT be silently discarded.

#### Scenario: A window read surfaces content from before the newest stored item
- **WHEN** a poll returns an unseen item whose platform timestamp is older than the newest stored item for that source
- **THEN** the service stores and displays it as historical and creates no reply job

#### Scenario: A blind lane recovers and sees a stale backlog
- **WHEN** a poll first observes an item that arrived more than 6 hours ago
- **THEN** the service stores and displays it as historical and creates no reply job, leaving it to a human

#### Scenario: An item arrives during normal polling
- **WHEN** an unseen inbound item is observed within one polling interval of its arrival and is not older than the newest stored item
- **THEN** neither condition blocks it and the existing eligibility rules decide the reply
