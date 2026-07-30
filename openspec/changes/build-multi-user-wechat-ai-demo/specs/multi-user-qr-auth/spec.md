## ADDED Requirements

### Requirement: Isolated browserless QR login
The service SHALL let each browser session request and poll a WeChat Channels QR login without starting or connecting to a browser runtime, and it SHALL bind the resulting platform authority only to that browser session.

#### Scenario: Two visitors request login concurrently
- **WHEN** two different browser sessions request QR login
- **THEN** the service returns different QR tokens, stores them under different tenant scopes, and never exposes either token through the other session

#### Scenario: QR login succeeds
- **WHEN** the platform reports a confirmed scan and the service obtains a bounded identity-bearing authenticated session
- **THEN** the service marks only the owning demo session authenticated and starts its baseline synchronization

#### Scenario: QR status succeeds without usable identity
- **WHEN** polling reports success but identity or required session material cannot be validated
- **THEN** the service does not mark the session authenticated and reports an actionable authentication or schema error

### Requirement: Encrypted credential lifecycle
The service MUST encrypt all persisted QR tokens, cookies, UIN values, private-message login cookies, platform identity identifiers, inbound customer content, and reply content with authenticated encryption scoped to the owning demo session.

#### Scenario: Credential row is inspected
- **WHEN** the SQLite credential row is read without the service encryption key
- **THEN** it contains no plaintext platform credential or identifier

#### Scenario: Content rows are inspected
- **WHEN** inbound-item or reply rows are read without the service encryption key
- **THEN** they contain no plaintext author name, message text, reply target, platform external ID, or generated reply

#### Scenario: Customer logs out
- **WHEN** the owning browser session requests logout and no dispatched send is awaiting its outcome
- **THEN** the service stops its workers and deletes its platform credentials and session-owned interaction content

#### Scenario: Customer logs out during an in-flight send
- **WHEN** the owning browser requests logout while a dispatched platform send has no terminal outcome
- **THEN** the service preserves the session-owned receipt record and returns an explicit retryable conflict

#### Scenario: Session expires
- **WHEN** a demo session exceeds its configured retention deadline
- **THEN** the service removes its credentials and data without affecting any other demo session

### Requirement: Tenant-safe API access
Every session API and event stream MUST derive ownership from an opaque HttpOnly cookie and MUST NOT accept client-selected account, Finder, message, or reply-target identifiers.

#### Scenario: Visitor attempts cross-session access
- **WHEN** one visitor supplies a URL or payload containing another session's identifiers
- **THEN** the service ignores client-selected ownership fields and returns no other session's state or content

#### Scenario: Same platform account is already active
- **WHEN** a second unexpired demo session completes login for a Finder identity already bound to another session
- **THEN** the service rejects the second binding without revealing which visitor owns the first session
