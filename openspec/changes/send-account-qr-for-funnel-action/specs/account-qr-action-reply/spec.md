## ADDED Requirements

### Requirement: Account business QR configuration
The service SHALL store at most one business QR image for each hosted Video Channels account, SHALL keep its bytes encrypted at rest, and SHALL accept only non-empty PNG or JPEG content no larger than 512 KiB.

#### Scenario: Configure or replace an account QR
- **WHEN** a Demo or authorized Partner client supplies a valid QR image for an existing account
- **THEN** the service atomically stores it for that account and reports its MIME type, byte length, and update time

#### Scenario: Reject invalid image input
- **WHEN** a client supplies malformed Base64, an unsupported MIME or magic signature, an empty image, or content larger than 512 KiB
- **THEN** the service rejects the request without replacing the account's current QR asset

#### Scenario: Remove an account QR
- **WHEN** a Demo or authorized Partner client removes the configured QR
- **THEN** the service deletes only that account's QR asset and reports it as not configured

#### Scenario: Keep account assets separate
- **WHEN** multiple hosted accounts configure different QR images
- **THEN** selecting or operating one account never reads, changes, or sends another account's image

#### Scenario: Bind Demo QR mutations to the displayed account
- **WHEN** another browser tab changes the shared selected-account cookie while a QR preview, replacement, or deletion is in flight
- **THEN** the operation remains bound to the account ID captured by the initiating page and a mismatched response is not applied

### Requirement: Asset-light QR API projections
The service SHALL expose QR configuration metadata through Demo and Partner account APIs and SHALL NOT include QR image bytes in account lists, content timelines, reply output, logs, or Partner account projections.

#### Scenario: Read QR configuration state
- **WHEN** a client reads an account or its QR settings
- **THEN** the response identifies whether a QR is configured and includes metadata only

#### Scenario: Preview the selected Demo account QR
- **WHEN** the Demo page requests the selected account's QR settings
- **THEN** the same-origin response may include that account's data URL for preview

#### Scenario: Partner reads QR settings
- **WHEN** an authorized Partner client reads an account's QR settings
- **THEN** the response excludes image bytes and returns only configuration metadata

### Requirement: Funnel QR action parsing
The Funnel adapter SHALL accept `send_wechat_qr` only on a valid direct-message response, SHALL preserve ordered `content_list` bubbles, and SHALL continue to reject all other non-empty actions before platform dispatch.

#### Scenario: Funnel asks to send the QR
- **WHEN** a valid Funnel private-message response contains `action: "send_wechat_qr"`
- **THEN** the generated reply contains the ordered text bubbles and an explicit QR-send action

#### Scenario: Unsupported action remains closed
- **WHEN** a Funnel response contains `escalate_to_human` or an unknown action
- **THEN** the reply job fails with the fixed `funnel_action_unsupported` code and sends neither text nor media

#### Scenario: Comments remain text-only
- **WHEN** the Funnel comment endpoint returns its documented response
- **THEN** the service handles only its public text reply and never derives a QR-send action

### Requirement: Account QR private-message delivery
For a Funnel direct-message `send_wechat_qr` action, the service SHALL validate the current account asset before platform dispatch, SHALL send all text bubbles in order, and SHALL then upload and send that account's QR as a Video Channels image message to the same conversation.

#### Scenario: Send text bubbles and configured QR
- **WHEN** Funnel returns ordered text bubbles and `send_wechat_qr` for an account with a configured QR
- **THEN** the service sends each text bubble in order and sends the QR image last to the same private-message target

#### Scenario: Send an action without text
- **WHEN** Funnel returns an empty content list and `send_wechat_qr` for an account with a configured QR
- **THEN** the service sends the QR image and does not classify the reply as skipped

#### Scenario: QR is not configured
- **WHEN** Funnel returns `send_wechat_qr` for an account without a configured QR
- **THEN** the reply fails as `account_wechat_qr_not_configured` before any Funnel text or image is dispatched

#### Scenario: Recipient-bound media upload
- **WHEN** the service prepares the QR image for delivery
- **THEN** it uploads 512 KiB data-URL chunks using the current account and recipient usernames and passes the final platform-returned `imgMsg` unchanged into a `msgType: 3` private-message send

#### Scenario: Confirmed image send
- **WHEN** the platform accepts the image send and returns a non-empty `svrMsgId`
- **THEN** the service includes that receipt in the reply's confirmed receipt hash

#### Scenario: Partial or ambiguous delivery
- **WHEN** any text was confirmed before image delivery fails, or the final image-send outcome is ambiguous
- **THEN** the service records `submitted_unknown`, preserves a bounded error code, and does not automatically retry the action

#### Scenario: Configured QR changes during dispatch
- **WHEN** the account QR is replaced or deleted after generation but before the next platform write
- **THEN** the service stops the stale turn before that write, never sends the old image, and preserves any already-confirmed text as `submitted_unknown`

#### Scenario: No image in non-Funnel paths
- **WHEN** a comment reply or CHAT-generated reply is processed
- **THEN** the service uses the existing text-only platform path even if the account has a QR configured
