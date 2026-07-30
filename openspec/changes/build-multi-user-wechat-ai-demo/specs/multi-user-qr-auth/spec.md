## ADDED Requirements

### Requirement: Browserless QR login into a global account pool
The service SHALL let a visitor request and poll a WeChat Channels QR login without starting or connecting to a browser runtime, SHALL bind the resulting platform authority to one encrypted server-side demo session, and SHALL preserve all other logged-in demo sessions.

#### Scenario: Two visitors request login concurrently
- **WHEN** two different browser sessions request QR login
- **THEN** the service returns different QR tokens, stores them under different encrypted session scopes, and does not replace either pending login

#### Scenario: QR login succeeds
- **WHEN** the platform reports a confirmed scan and the service obtains a bounded identity-bearing authenticated session
- **THEN** the service marks that demo session authenticated, starts its baseline synchronization, and makes its safe account summary available in the global session list

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
- **WHEN** any visitor requests logout for the currently selected shared session and no dispatched send is awaiting its outcome
- **THEN** the service stops its workers and deletes its platform credentials and session-owned interaction content

#### Scenario: Customer logs out during an in-flight send
- **WHEN** any visitor requests logout for the selected shared session while a dispatched platform send has no terminal outcome
- **THEN** the service preserves the session-owned receipt record and returns an explicit retryable conflict

#### Scenario: Session expires
- **WHEN** a demo session exceeds its configured retention deadline
- **THEN** the service removes its credentials and data without affecting any other demo session

### Requirement: Global shared demo-session selection
The service SHALL expose safe summaries for every unexpired logged-in demo session and SHALL let any visitor select one through an opaque server-generated demo-session identifier, without an administrator password, workspace boundary, or browser-session ownership check.

#### Scenario: Visitor lists shared accounts
- **WHEN** any visitor requests the shared demo-session list
- **THEN** the service returns every unexpired logged-in account's opaque session identifier, safe display name, state, and expiry without returning platform credentials or raw platform identifiers

#### Scenario: Visitor selects another account
- **WHEN** a visitor selects an opaque identifier from the shared list
- **THEN** subsequent snapshot, event, stop/resume, refresh, and logout operations resolve the selected demo session

#### Scenario: Visitor adds another account
- **WHEN** a visitor chooses to add a video account
- **THEN** the service creates a fresh QR-login session, selects it for that browser, and leaves all existing logged-in sessions unchanged

#### Scenario: Visitor supplies a platform target
- **WHEN** a visitor supplies a Finder, message, post, comment, or reply-target identifier
- **THEN** the service does not use that client value to select platform authority or an irreversible write target

#### Scenario: Same platform account is already active
- **WHEN** a second unexpired demo session completes login for a Finder identity already bound to another session
- **THEN** the service rejects the duplicate binding or reuses the existing shared account without starting a second worker for that Finder identity

#### Scenario: Production cookie security is configured
- **WHEN** production starts without an explicit cookie override
- **THEN** the session cookie is Secure, and an insecure production override is accepted only when the service listener is bound to a loopback host

### Requirement: Server-owned session lifetime and workers
The service MUST keep login, inbound synchronization, and automatic-reply workers tied to the unexpired server-side demo session rather than to a browser page, SSE connection, or polling request.

#### Scenario: Visitor closes the page
- **WHEN** a visitor closes the page after selecting or logging in an account
- **THEN** the service continues eligible synchronization and automatic-reply work for that account until it is stopped, logged out, expired, or the service-wide switch is disabled

#### Scenario: Visitor returns later
- **WHEN** a visitor opens the public demo again while one or more logged-in sessions remain unexpired
- **THEN** the page can list and select those existing sessions without requiring the original browser cookie
