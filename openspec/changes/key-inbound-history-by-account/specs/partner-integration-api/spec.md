## MODIFIED Requirements

### Requirement: Source-specific content reads
The service SHALL expose comments and direct messages through separate account-scoped endpoints and SHALL return only normalized display content and reply state. Content SHALL be the hosted WeChat account's ledger: items discovered by a predecessor container of the same account are included, and an account with no completed login has no content.

#### Scenario: Read comments
- **WHEN** the caller gets `/comments`
- **THEN** every returned item has source `comment` and includes opaque ID, author display name, text, occurrence time, historical and eligibility flags, and current reply state

#### Scenario: Read direct messages
- **WHEN** the caller gets `/direct-messages`
- **THEN** every returned item has source `dm` and preserves any multi-part reply as a `messages` array

#### Scenario: Content survives a container takeover
- **WHEN** the hosted account re-logged in from a new Partner account and the caller reads content from the successor
- **THEN** items discovered and answered under the retired container are returned with their reply state, unchanged in shape

#### Scenario: Sensitive platform details remain internal
- **WHEN** any content page is returned
- **THEN** it contains no raw platform target, Finder identifier, post/comment/session ID, encrypted envelope, concrete model name, upstream host, or provider request ID
