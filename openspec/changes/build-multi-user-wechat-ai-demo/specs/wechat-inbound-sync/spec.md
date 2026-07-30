## ADDED Requirements

### Requirement: Historical baseline before automation
The service SHALL retrieve an initial bounded snapshot of direct messages and comments for an authenticated account, display that content as historical, and complete a separate durable baseline for each source before enabling new-item automation for that source.

#### Scenario: Existing content is discovered during baseline
- **WHEN** the first successful direct-message or comment snapshot contains existing items
- **THEN** the service persists and displays them with `replyEligible=false` and creates no reply job

#### Scenario: Baseline has continuation pages
- **WHEN** the platform reports another history, post, or comment page
- **THEN** the service durably advances the cursor but keeps the source baseline incomplete and every subsequent baseline page ineligible for reply until no continuation remains

#### Scenario: One source baseline fails
- **WHEN** direct-message baseline succeeds but comment baseline fails or changes schema
- **THEN** direct-message incremental sync may operate while comment automation remains disabled and visibly degraded

### Requirement: Incremental normalized inbox
After a source baseline is complete, the service SHALL poll bounded incremental data, normalize new inbound text items, and deduplicate them durably within the owning demo session.

#### Scenario: Same platform item appears in multiple polls
- **WHEN** a direct message or comment with the same immutable external ID is observed repeatedly
- **THEN** the service stores one inbox item and creates at most one reply job

#### Scenario: Authenticated account's own message is observed
- **WHEN** an item is authored by the authenticated Finder identity
- **THEN** the service displays it if useful but does not mark it reply eligible

#### Scenario: New inbound text appears after baseline
- **WHEN** an unseen text item authored by another user is first observed after its source baseline
- **THEN** the service records the exact source reply target and marks the item eligible for automatic reply

#### Scenario: Post order changes during comment pagination
- **WHEN** a post list is reordered while a durable comment cursor is partway through one post
- **THEN** the service continues only by the bound `objectId/exportId`, and fails closed if that identity disappears or the page membership changes

#### Scenario: Second-level comment is observed
- **WHEN** the comment response contains a text node under a top-level comment
- **THEN** the service creates a separate normalized item with the stable root ID, the current comment as parent, and a sanitized write context with no embedded child list

#### Scenario: Comment write context has an inexact field
- **WHEN** a captured reply-context field has the wrong string, finite-number, or boolean type, or its comment ID differs from the normalized target
- **THEN** the source fails closed before creating an item that could reach an irreversible comment write

### Requirement: Honest source health
The service MUST report per-source last success, last error, and schema state without converting an empty result, authentication failure, or parse failure into successful new-content synchronization.

#### Scenario: Platform returns an empty valid page
- **WHEN** a bounded response matches the known schema and contains no items
- **THEN** the service records a successful sync with zero new items

#### Scenario: Platform response shape is unknown
- **WHEN** required fields cannot be parsed from the platform response
- **THEN** the affected source enters `schema_changed`, creates no reply jobs, and does not expose raw credential-bearing response data
