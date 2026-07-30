## ADDED Requirements

### Requirement: Configured Doubao generation
For each eligible new inbound text item, the service SHALL call the configured Volcengine Ark model with the requested default model identifier `doubao-seed-character-260628` and SHALL produce one bounded plain-text reply or an explicit generation failure.

#### Scenario: Model returns usable text
- **WHEN** the configured model returns non-empty text within the allowed bound
- **THEN** the service records that exact generated text and advances the reply to delivery

#### Scenario: Exact model is unavailable
- **WHEN** the provider rejects the configured model or endpoint identifier
- **THEN** the service records a visible model error and does not silently use another model or send a reply

#### Scenario: Model response is empty or malformed
- **WHEN** the provider response contains no usable assistant text
- **THEN** the service marks generation failed and performs no platform write

#### Scenario: Model response is incomplete or never finishes
- **WHEN** the provider reports a non-stop finish reason, exceeds the response-size bound, or fails to finish before the end-to-end timeout
- **THEN** the service records an explicit model failure and performs no platform write

### Requirement: Exact-target automatic delivery
The service SHALL derive the delivery target only from the normalized inbound item and SHALL support text replies to direct messages and comments without client-supplied target identifiers.

#### Scenario: Direct-message reply is confirmed
- **WHEN** the platform confirms sending generated text to the exact source conversation
- **THEN** the service records the reply `confirmed` and exposes the confirmation in the owning session timeline

#### Scenario: Comment reply is confirmed
- **WHEN** the platform confirms replying to the exact source post, root comment, and parent comment
- **THEN** the service records the reply `confirmed` and exposes the confirmation in the owning session timeline

#### Scenario: Delivery result is ambiguous
- **WHEN** a request may have reached the platform but the response is lost, times out, or cannot be parsed
- **THEN** the service records `submitted_unknown` and never automatically resends that reply

#### Scenario: Authority changes before dispatch
- **WHEN** login, stop, logout, run generation, or session expiry changes after generation but before the network dispatch boundary
- **THEN** the service rejects dispatch and sends no platform request

#### Scenario: Sync and send refresh different cookies
- **WHEN** one demo session has synchronization and delivery work ready at the same time
- **THEN** the service serializes its WeChat platform I/O, reloads the latest encrypted credential before send, and retains both CookieJar updates

#### Scenario: Session mutation is requested after dispatch
- **WHEN** QR refresh or logout is requested while a dispatched reply is still waiting for its terminal receipt
- **THEN** the service returns `platform_send_in_flight`, preserves the job and session scope, and permits the mutation after the outcome is persisted

### Requirement: Automation stop controls
The service MUST honor both a per-session automation stop and a service-wide automation switch before claiming a new reply job.

#### Scenario: Customer stops automation
- **WHEN** the owning visitor disables automatic replies
- **THEN** the service continues displaying new content but claims no new reply jobs for that session

#### Scenario: Service-wide switch is disabled
- **WHEN** the operator disables the global automatic-reply switch
- **THEN** no tenant receives newly generated or sent replies until the switch is enabled again
