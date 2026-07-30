## ADDED Requirements

### Requirement: Customer-visible login and account state
The demo page SHALL show the owning visitor's QR code, QR expiry, scan/authentication state, safe account display name, baseline state, and per-source health without exposing platform credentials or raw identifiers.

#### Scenario: Visitor opens a new demo session
- **WHEN** a browser with no valid demo cookie opens the page
- **THEN** the service creates an isolated session and the page offers QR login without showing another visitor's state

#### Scenario: Authentication completes
- **WHEN** the backend validates the scanned account and starts baseline synchronization
- **THEN** the page transitions from QR status to a safe account summary and live source status

### Requirement: Real-time interaction timeline
The page SHALL receive authenticated server-sent updates and display historical inbound items, new inbound items, generated text, and delivery outcomes for only the owning demo session.

#### Scenario: New direct message is processed
- **WHEN** a new direct message is discovered, generated, and delivered
- **THEN** the page shows the inbound text followed by generation and the honest final delivery state without a full-page refresh

#### Scenario: Stream reconnects
- **WHEN** the SSE connection is interrupted and reconnects
- **THEN** the client reloads an authoritative session snapshot and does not duplicate timeline records

### Requirement: Customer stop and logout
The page SHALL provide controls to stop or resume new automatic replies and to log out and delete the current demo session.

#### Scenario: Visitor stops replies
- **WHEN** the visitor selects stop
- **THEN** the page reflects the backend-confirmed stopped state while inbound synchronization remains visible

#### Scenario: Visitor logs out
- **WHEN** the visitor confirms logout and no dispatched send outcome is pending
- **THEN** the backend deletes the session scope, clears the browser cookie, closes the event stream, and returns the page to a new-session state

#### Scenario: Logout is temporarily blocked by an in-flight send
- **WHEN** the backend returns `platform_send_in_flight`
- **THEN** the page keeps the current session visible, reports the retryable conflict, and does not clear the cookie

### Requirement: Transparent demo limitations
The page SHALL state that WeChat Channels access uses private undocumented interfaces, that credentials are temporarily held by the demo service, and that the artifact is not an official production integration.

#### Scenario: Login consent is presented
- **WHEN** the visitor is asked to scan a QR code
- **THEN** the page visibly presents the credential-custody and private-interface notice before login
