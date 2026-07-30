## ADDED Requirements

### Requirement: Customer-visible login and account state
The demo page SHALL show the selected session's QR code, QR expiry, scan/authentication state, safe account display name, baseline state, and per-source health without exposing platform credentials or raw identifiers.

#### Scenario: Visitor opens a new demo session
- **WHEN** a browser with no valid demo cookie opens the page
- **THEN** the page lists existing logged-in demo accounts when present and offers either selecting one or adding another account by QR

#### Scenario: Authentication completes
- **WHEN** the backend validates the scanned account and starts baseline synchronization
- **THEN** the page transitions from QR status to a safe account summary and live source status

### Requirement: Global session-switching tab
The demo page SHALL provide a `会话切换` tab that lists every unexpired logged-in account and lets any visitor switch accounts or add another account without an administrator password, workspace selector, browser-ownership check, or shared-access consent gate.

#### Scenario: Visitor switches accounts
- **WHEN** a visitor selects a different account from the global session list
- **THEN** the page switches its authoritative snapshot and update channel to that account without logging out or replacing either account

#### Scenario: Visitor adds an account
- **WHEN** a visitor selects `添加视频号`
- **THEN** the page creates and selects a fresh login session, displays its QR flow, and keeps every existing account in the global list

#### Scenario: Visitor closes and reopens the page
- **WHEN** a visitor leaves and later opens the public demo URL
- **THEN** the page can recover the global list of still-unexpired accounts and select any of them while their server-side workers continue independently

### Requirement: Live interaction timeline
The page SHALL display historical inbound items, new inbound items, generated text, and delivery outcomes for only the currently selected demo session, using server-sent updates where supported and a bounded authoritative snapshot fallback where they are not.

#### Scenario: New direct message is processed
- **WHEN** a new direct message is discovered, generated, and delivered
- **THEN** the page shows the inbound text followed by generation and the honest final delivery state without a full-page refresh

#### Scenario: Stream reconnects
- **WHEN** the SSE connection is interrupted and reconnects
- **THEN** the client reloads an authoritative session snapshot and does not duplicate timeline records

#### Scenario: Public Quick Tunnel does not support SSE
- **WHEN** the page is served from a `.trycloudflare.com` public hostname
- **THEN** the client skips `EventSource` and refreshes the authoritative selected-session and shared-session snapshots on a fixed five-second interval

### Requirement: Customer stop and logout
The page SHALL provide controls to stop or resume new automatic replies and to log out and delete the currently selected demo session.

#### Scenario: Visitor stops replies
- **WHEN** the visitor selects stop
- **THEN** the page reflects the backend-confirmed stopped state for the selected account while inbound synchronization remains visible

#### Scenario: Visitor logs out
- **WHEN** the visitor confirms logout and no dispatched send outcome is pending
- **THEN** the backend deletes that shared session scope, clears its selection, closes the event stream, and returns the page to the remaining global session list or a new-session state

#### Scenario: Logout is temporarily blocked by an in-flight send
- **WHEN** the backend returns `platform_send_in_flight`
- **THEN** the page keeps the current session visible, reports the retryable conflict, and does not clear the cookie

### Requirement: Transparent demo limitations
The page SHALL state that WeChat Channels access uses private undocumented interfaces, that credentials are temporarily held by the demo service, and that the artifact is not an official production integration.

#### Scenario: Login consent is presented
- **WHEN** the visitor is asked to scan a QR code
- **THEN** the page visibly presents the credential-custody and private-interface notice before login

### Requirement: Generic public model presentation
The public page MUST label the reply capability as `chat角色模型`, the model card as `chat-llm`, and generated timeline output as `CHAT回复`, and MUST NOT expose `doubao-seed-character-260628` or provider credentials in public HTML, JavaScript, snapshots, or events.

#### Scenario: Model is configured
- **WHEN** the server reports that the configured reply model is available
- **THEN** the page shows `chat-llm` as configured without revealing the concrete server-side model identifier

#### Scenario: Generated reply is displayed
- **WHEN** the selected account timeline contains generated reply text
- **THEN** the page labels it `CHAT回复`
