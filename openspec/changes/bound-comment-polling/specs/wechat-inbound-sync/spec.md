## MODIFIED Requirements

### Requirement: Historical baseline before automation
The service SHALL retrieve an initial bounded snapshot of direct messages and comments for an authenticated account, display that content as historical, and complete a separate durable baseline for each source before enabling new-item automation for that source. A comment baseline SHALL consist of one post-list read, at most the first 3 posts, and one comment-list read for each selected post.

#### Scenario: Existing content is discovered during baseline
- **WHEN** the first successful direct-message or comment snapshot contains existing items
- **THEN** the service persists and displays them with `replyEligible=false` and creates no reply job

#### Scenario: Direct-message baseline has continuation pages
- **WHEN** the platform reports another direct-message history page
- **THEN** the service durably advances the cursor but keeps the direct-message baseline incomplete and every subsequent baseline page ineligible for reply until no continuation remains

#### Scenario: Comment baseline response has continuation markers
- **WHEN** the first 3 posts or their first comment pages report additional post or comment pages
- **THEN** the service completes the bounded comment baseline without requesting those continuation pages

#### Scenario: One source baseline fails
- **WHEN** direct-message baseline succeeds but comment baseline fails or changes schema
- **THEN** direct-message incremental sync may operate while comment automation remains disabled and visibly degraded

#### Scenario: Superseded comment cursor failure is recovered
- **WHEN** a retained comment source contains `schema_changed:post.cursor_target_missing` from the previous pagination strategy
- **THEN** the service retains existing inbox rows, makes the next bounded comment scan a historical baseline, and creates no reply jobs for items first found by that recovery scan

### Requirement: Incremental normalized inbox
After a source baseline is complete, the service SHALL poll bounded incremental data, normalize new inbound text items, and deduplicate them durably within the owning demo session. Each comment source SHALL be polled no more often than once every 60 seconds; one comment poll SHALL fetch the post list exactly once, select at most the first 3 posts, and fetch exactly one comment page for each selected post.

#### Scenario: Same platform item appears in multiple polls
- **WHEN** a direct message or comment with the same immutable external ID is observed repeatedly
- **THEN** the service stores one inbox item and creates at most one reply job

#### Scenario: Authenticated account's own message is observed
- **WHEN** an item is authored by the authenticated Finder identity
- **THEN** the service displays it if useful but does not mark it reply eligible

#### Scenario: New inbound text appears after baseline
- **WHEN** an unseen text item authored by another user is first observed after its source baseline
- **THEN** the service records the exact source reply target and marks the item eligible for automatic reply

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

### Requirement: Honest source health
The service MUST report per-source last success, last error, and schema state without converting an unexpected empty result, authentication failure, or parse failure into successful new-content synchronization.

#### Scenario: Comment context is missing
- **WHEN** the encrypted session does not contain a validated current first-party request context
- **THEN** the comment source fails closed before dispatch and does not treat the legacy root endpoint's empty response as a healthy comment baseline

#### Scenario: New account has an empty valid post page
- **WHEN** a bounded capture-backed response matches the known schema, contains no posts, and the source has no evidence of previously observed posts
- **THEN** the service records a successful sync with zero new items

#### Scenario: Previously non-empty account returns an empty post page
- **WHEN** the comment source has evidence of previously observed posts and the platform returns a successful response with an empty post list
- **THEN** the service records a retryable `platform_post_list_empty` error, creates no reply jobs, and waits at least 60 seconds before retrying

#### Scenario: Retained completed source has an ambiguous legacy null cursor
- **WHEN** an upgraded comment source has a completed baseline and its previous pagination cursor decrypts to `null`
- **THEN** the service conservatively treats the source as previously observed until a successful bounded scan persists an explicit v3 observation marker

#### Scenario: Comment reads fail after observing posts
- **WHEN** a non-empty post list is validated but any selected post's comment-list request fails
- **THEN** the service retains durable evidence that posts were observed, keeps an incomplete baseline incomplete, and cannot treat a later empty post list as a successful empty baseline

#### Scenario: Platform response shape is unknown
- **WHEN** required fields cannot be parsed from the platform response
- **THEN** the affected source enters `schema_changed`, creates no reply jobs, and does not expose raw credential-bearing response data
