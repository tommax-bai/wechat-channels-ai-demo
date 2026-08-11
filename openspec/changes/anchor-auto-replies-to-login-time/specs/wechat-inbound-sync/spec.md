## MODIFIED Requirements

### Requirement: Historical baseline before automation
The service SHALL retrieve an initial bounded snapshot of direct messages and comments for an authenticated account and SHALL complete a separate durable baseline for each source. A comment baseline SHALL consist of one post-list read, at most the first 3 posts, and one comment-list read for each selected post. Baseline completion SHALL govern pagination and source health only; reply eligibility SHALL be decided by the login-time anchor rule regardless of whether an item was discovered by a baseline, an incremental poll, or a recovery scan.

#### Scenario: Pre-login content is discovered during baseline
- **WHEN** a baseline snapshot contains items that occurred before the current authorization's login-success time
- **THEN** the service persists and displays them as historical with `replyEligible=false` and creates no reply job

#### Scenario: An item arrives while the baseline is still walking
- **WHEN** a baseline page surfaces an unseen item that occurred at or after the current login-success time and within the maximum automatic-reply age
- **THEN** the service marks it reply eligible even though its source baseline is not yet complete

#### Scenario: Direct-message baseline has continuation pages
- **WHEN** the platform reports another direct-message history page
- **THEN** the service durably advances the cursor and keeps the direct-message baseline incomplete until no continuation remains

#### Scenario: Comment baseline response has continuation markers
- **WHEN** the first 3 posts or their first comment pages report additional post or comment pages
- **THEN** the service completes the bounded comment baseline without requesting those continuation pages

#### Scenario: One source baseline fails
- **WHEN** direct-message baseline succeeds but comment baseline fails or changes schema
- **THEN** direct-message incremental sync may operate while comment automation remains disabled and visibly degraded

#### Scenario: Superseded comment cursor failure is recovered
- **WHEN** a retained comment source contains `schema_changed:post.cursor_target_missing` from the previous pagination strategy
- **THEN** the service retains existing inbox rows, re-baselines on the next bounded comment scan, and applies the login-time anchor rule to items first found by that recovery scan

### Requirement: Automatic replies only for genuinely new content
A first-seen item SHALL become eligible for an automatic reply only when it occurred at or after the current authorization's login-success time and it arrived within the maximum automatic-reply age of 6 hours. An item failing either condition SHALL be stored and displayed as historical, SHALL create no reply job, and SHALL NOT be silently discarded. The login-success time SHALL be persisted with the session and stamped on every successful authentication, so a re-scan after expiry moves the anchor to the new login.

#### Scenario: An item from before login is surfaced
- **WHEN** a poll or scan returns an unseen item whose platform timestamp is earlier than the current login-success time
- **THEN** the service stores and displays it as historical and creates no reply job

#### Scenario: A post-login item is surfaced behind newer stored content
- **WHEN** a poll first observes an unseen item that occurred after the current login-success time and within the maximum automatic-reply age, while the source already holds a newer stored item
- **THEN** the service marks it reply eligible; no stored-item watermark blocks it

#### Scenario: A blind lane recovers and sees a stale backlog
- **WHEN** a poll first observes an item that arrived more than 6 hours ago
- **THEN** the service stores and displays it as historical and creates no reply job, leaving it to a human

#### Scenario: The account is re-scanned after its login expired
- **WHEN** authentication completes again and an unseen item from the logged-out gap is later surfaced
- **THEN** the service stores and displays it as historical, because it occurred before the new login-success time

#### Scenario: An item arrives during normal polling
- **WHEN** an unseen inbound item that occurred after the current login-success time is observed within one polling interval of its arrival
- **THEN** neither condition blocks it and the existing eligibility rules decide the reply

#### Scenario: A retained session has no recorded login time
- **WHEN** the migration reaches a session row created before this change
- **THEN** the service backfills its anchor with the migration time, so content from before the deploy is historical and content after it is eligible
