## ADDED Requirements

### Requirement: Partner API authentication
The service SHALL expose integration routes only under `/partner/v1`, SHALL authenticate every integration request with the configured Bearer API key, and SHALL never expose the key through logs, readiness, responses, or documentation.

#### Scenario: Valid server credential
- **WHEN** a caller sends a Partner API request with the configured Bearer credential
- **THEN** the service processes the request without using a browser Cookie or implicit browser session

#### Scenario: Missing or invalid credential
- **WHEN** the Partner API is configured and a request has no matching Bearer credential
- **THEN** the service returns HTTP 401 with error code `partner_api_unauthorized`

#### Scenario: API not configured
- **WHEN** no Partner API credential is configured
- **THEN** a request under `/partner/v1` returns HTTP 503 with error code `partner_api_unavailable`

### Requirement: Explicit account lifecycle
The service SHALL let an authenticated caller create, list, inspect, and delete retained account containers using an opaque `accountId`, and a newly created Partner account SHALL start with automatic replies disabled.

#### Scenario: Create an account container
- **WHEN** the caller posts to `/partner/v1/accounts`
- **THEN** the service returns HTTP 201 with a new opaque account ID and its initial status without setting a browser Cookie

#### Scenario: List accounts at every login stage
- **WHEN** the caller lists accounts
- **THEN** the response includes retained new, QR-pending, logged-in, paused, and platform-expired accounts but excludes deleted or logged-out accounts

#### Scenario: Unknown account
- **WHEN** an account-scoped call names an absent, deleted, logged-out, or no-longer-retained account
- **THEN** the service returns HTTP 404 with error code `partner_account_not_found`

#### Scenario: Delete account
- **WHEN** the caller deletes an account with no platform send in flight
- **THEN** the service removes its credentials and dependent content and returns HTTP 204

### Requirement: QR login creation and observation
The service SHALL let the caller create or refresh a QR login and poll a status that distinguishes QR availability, scan detection, initialization, and completed login.

#### Scenario: Request a QR for a new account
- **WHEN** the caller requests a login QR for an eligible account
- **THEN** the response contains `login.state` equal to `waiting_scan`, a PNG data URL, and the QR-attempt expiry time

#### Scenario: QR provider is unavailable
- **WHEN** the platform QR creation request fails before a login attempt is stored
- **THEN** the service returns HTTP 502 with error code `partner_login_qr_unavailable` and preserves the account for an explicit retry

#### Scenario: Scan detected but login incomplete
- **WHEN** WeChat reports that the QR was scanned but the service has not validated and persisted the complete platform context
- **THEN** login status reports `scanned: true` and `succeeded: false`

#### Scenario: Login succeeds
- **WHEN** the service has validated and persisted the platform session
- **THEN** login status reports `succeeded: true`, exposes the account display name when known, and never exposes platform credentials or identifiers

#### Scenario: QR expires
- **WHEN** the current QR attempt expires before successful login
- **THEN** login status reports `qr_expired`, no usable QR image, and does not claim that a hosted credential expired

#### Scenario: Login initialization fails before persistence
- **WHEN** QR polling or context capture fails before a platform session credential is persisted
- **THEN** login reports `failed`, hosting remains `not_ready` with `loginExpired: false`, and the caller can request a new QR

#### Scenario: Relogin would destroy a valid or in-progress context
- **WHEN** the caller requests another QR while login initialization is in progress or the account has a valid hosted context
- **THEN** the service returns HTTP 409 with a stable state-conflict error and preserves existing credentials and content

### Requirement: Hosting and credential status
The service SHALL expose hosting status separately from QR status and SHALL treat platform `auth_required` as the sole affirmative signal that a previously hosted login has expired.

#### Scenario: Hosted account is active
- **WHEN** login has succeeded, both source baselines have completed, and automatic reply is enabled
- **THEN** hosting reports `active`, `loginExpired: false`, and `credentialExpiresAt: null`

#### Scenario: Automatic reply is paused
- **WHEN** the caller disables hosting automation while the login remains usable
- **THEN** hosting reports `paused` and `loginExpired: false` while existing synchronization behavior continues

#### Scenario: Platform rejects the persisted login
- **WHEN** the platform returns the canonical `auth_required` outcome for an already persisted platform session
- **THEN** hosting reports `expired`, `loginExpired: true`, and `reloginRequired: true`

#### Scenario: Source or schema failure is not expiry
- **WHEN** synchronization reports an ordinary error or schema change without `auth_required`
- **THEN** hosting reports a degraded state with source details and does not mark the login expired

### Requirement: Reply provider and job selection
The service SHALL expose configured reply-provider capabilities and SHALL let callers select either `chat-llm` or `funnel`, with a known job number required only for Funnel.

#### Scenario: List provider capabilities
- **WHEN** the caller gets Partner capabilities
- **THEN** the response contains stable provider IDs, display names, configured availability, and whether a job number is required without exposing a concrete model name or upstream endpoint

#### Scenario: Select CHAT replies
- **WHEN** the caller writes reply settings with provider `chat-llm`
- **THEN** the account uses the existing CHAT reply provider without requiring a job number

#### Scenario: Select Funnel replies with a job
- **WHEN** the caller writes reply settings with provider `funnel` and a non-empty job number
- **THEN** the service stores that selection and returns it in account status

#### Scenario: Funnel job is missing
- **WHEN** the caller selects `funnel` without a non-empty job number
- **THEN** the service returns HTTP 400 with error code `funnel_job_number_required` and does not alter the prior selection

#### Scenario: Job catalogue is requested
- **WHEN** a caller relies on the Partner contract to discover jobs
- **THEN** the published capability and documentation state that no job catalogue is available and require the caller to supply a known `jobNumber`

### Requirement: Hosting automation control
The service SHALL let the caller enable or pause the existing automatic-reply worker for an explicit account and SHALL report both the persisted automation flag and whether it is currently effective with the service switch, selected provider, and login state.

#### Scenario: Enable configured automation
- **WHEN** login is usable, the selected provider is configured, and the caller enables hosting
- **THEN** account status reports automation enabled and effective

#### Scenario: Provider is unavailable
- **WHEN** the caller enables hosting while the selected provider is not configured
- **THEN** the service keeps the persisted automation flag disabled, reports automation ineffective, and reports the selected provider as unavailable

### Requirement: Source-specific content reads
The service SHALL expose comments and direct messages through separate account-scoped endpoints and SHALL return only normalized display content and reply state.

#### Scenario: Read comments
- **WHEN** the caller gets `/comments`
- **THEN** every returned item has source `comment` and includes opaque ID, author display name, text, occurrence time, historical and eligibility flags, and current reply state

#### Scenario: Read direct messages
- **WHEN** the caller gets `/direct-messages`
- **THEN** every returned item has source `dm` and preserves any multi-part reply as a `messages` array

#### Scenario: Sensitive platform details remain internal
- **WHEN** any content page is returned
- **THEN** it contains no raw platform target, Finder identifier, post/comment/session ID, encrypted envelope, concrete model name, upstream host, or provider request ID

### Requirement: Stable content pagination
The content endpoints SHALL implement keyset pagination ordered by discovery time descending and opaque row ID descending, with a default limit of 50 and a maximum of 100.

#### Scenario: More content exists
- **WHEN** more matching rows exist after the requested page
- **THEN** the response sets `hasMore: true` and returns a `nextCursor` that retrieves only the next rows for the same account and source

#### Scenario: Cursor used for another scope
- **WHEN** a cursor is malformed or is reused with another account or content source
- **THEN** the service returns HTTP 400 with error code `invalid_cursor`

#### Scenario: Reply status changes after first read
- **WHEN** an item's asynchronous reply state changes between polls
- **THEN** subsequent reads return the same item ID with the current reply state so callers can upsert it

### Requirement: Stable API errors and response handling
The Partner API SHALL return JSON errors with a stable `error` code, SHALL set `Cache-Control: no-store`, and SHALL not set or depend on browser session cookies.

#### Scenario: Invalid request body or query
- **WHEN** an authenticated request fails schema validation
- **THEN** the service returns HTTP 400 with error code `invalid_request`

#### Scenario: Partner response headers
- **WHEN** any Partner API response is sent
- **THEN** it is marked `no-store` and contains no `Set-Cookie` header

### Requirement: Published integration contract
The repository SHALL include human-readable Partner API documentation and a machine-readable OpenAPI document that agree with the implemented routes, fields, status semantics, authentication, polling behavior, and known limitations.

#### Scenario: Colleague integrates the login and content UI
- **WHEN** the colleague follows the published contract
- **THEN** they can create an account, display and poll a QR, distinguish scan from login success, inspect hosting expiry, select provider and job number, and page comments and direct messages without using the Demo page

#### Scenario: Documentation does not leak deployment secrets
- **WHEN** the documentation is committed or shared
- **THEN** it contains placeholders rather than API keys, platform credentials, or upstream private endpoints
