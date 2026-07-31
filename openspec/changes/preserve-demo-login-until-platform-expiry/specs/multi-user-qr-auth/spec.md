## MODIFIED Requirements

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

#### Scenario: Authenticated session crosses the former local deadline
- **WHEN** an authenticated platform session remains accepted by WeChat after its former configured Demo retention deadline
- **THEN** the service preserves its credentials, content, workers, and automatic-reply eligibility without requiring a fresh QR

#### Scenario: Platform rejects stored authorization
- **WHEN** a WeChat synchronization or unambiguous send response explicitly reports that authentication is required
- **THEN** the service stops new synchronization and sends for that account, preserves its encrypted session scope, and visibly requests a fresh QR login

#### Scenario: Abandoned unauthenticated session reaches its cleanup deadline
- **WHEN** a Demo session has not completed platform authentication and exceeds its configured transient cleanup deadline
- **THEN** the service removes that session and its partial credentials without affecting any authenticated account

### Requirement: Global shared demo-session selection
The service SHALL expose safe summaries for every retained logged-in demo session and SHALL let any visitor select one through an opaque server-generated demo-session identifier, without an administrator password, workspace boundary, browser-session ownership check, or fabricated platform-session expiry.

#### Scenario: Visitor lists shared accounts
- **WHEN** any visitor requests the shared demo-session list
- **THEN** the service returns every retained logged-in account's opaque session identifier, safe display name, state, and automation state without returning platform credentials, raw platform identifiers, or a Demo-generated login-expiry timestamp

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
- **WHEN** a second retained demo session completes login for a Finder identity already bound to another session
- **THEN** the service rejects the duplicate binding or reuses the existing shared account without starting a second worker for that Finder identity

#### Scenario: Production cookie security is configured
- **WHEN** production starts without an explicit cookie override
- **THEN** the session cookie is Secure, and an insecure production override is accepted only when the service listener is bound to a loopback host

### Requirement: Server-owned session lifetime and workers
The service MUST keep authenticated login authority, inbound synchronization, and automatic-reply workers tied to the server-side platform session rather than to a browser page, SSE connection, polling request, or Demo-generated absolute deadline.

#### Scenario: Visitor closes the page
- **WHEN** a visitor closes the page after selecting or logging in an account
- **THEN** the service continues eligible synchronization and automatic-reply work until the account is stopped, explicitly logged out, the service-wide switch is disabled, or WeChat rejects the stored authorization

#### Scenario: Visitor returns later
- **WHEN** a visitor opens the public Demo while one or more platform sessions remain retained
- **THEN** the page can list and select those existing sessions without requiring the original browser cookie or a new QR scan

#### Scenario: Service restarts after the former local deadline
- **WHEN** the service restarts with an authenticated platform session whose former local retention deadline has passed
- **THEN** the service restores its worker eligibility and continues using it unless WeChat explicitly rejects the stored authorization

#### Scenario: Login authority is rejected
- **WHEN** WeChat explicitly returns an authentication-required response for a retained session
- **THEN** the page marks that account as requiring login and offers a fresh QR without treating page closure or elapsed local time as the cause
