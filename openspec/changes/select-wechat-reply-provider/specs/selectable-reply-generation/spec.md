## ADDED Requirements

### Requirement: Account-scoped provider selection
The Demo SHALL persist one reply provider per retained Video Channels account and SHALL default existing and new accounts to `chat-llm`.

#### Scenario: Switch one account to the recruitment provider
- **WHEN** an operator saves the recruitment provider and a non-empty job number for the selected account
- **THEN** the Demo persists that choice for the account across page refresh, account switching, and service restart without changing another account

#### Scenario: Switch back to CHAT
- **WHEN** an operator selects the CHAT provider
- **THEN** subsequent reply jobs for that account use CHAT generation while the saved recruitment job number remains available for a later switch

### Requirement: Provider configuration admission
The Demo MUST require the selected provider to be configured before enabling it and MUST keep upstream host details server-side.

#### Scenario: Recruitment provider lacks a job number
- **WHEN** an operator attempts to select the recruitment provider without a non-blank job number
- **THEN** the settings request fails and the current provider remains unchanged

#### Scenario: Recruitment service is not configured
- **WHEN** the server has no valid recruitment base URL and an operator attempts to select the recruitment provider
- **THEN** the settings request fails without exposing the upstream URL to the browser

#### Scenario: A persisted provider becomes unavailable after restart
- **WHEN** a retained account selects the recruitment provider but the server restarts without that provider configured
- **THEN** the Demo disables automatic reply for that account before reply workers start, terminally fails any queued replies from the superseded run generation, and preserves the provider choice for operator correction

### Requirement: Source-specific recruitment routing
When the recruitment provider is selected, the Demo MUST call the comment endpoint only for comments and the B2C IM endpoint only for direct messages from the DEV backend.

#### Scenario: Generate a comment reply
- **WHEN** a new eligible Video Channels comment is claimed for recruitment generation
- **THEN** the backend posts its unmodified text as `comment` to `/job/comment-reply/{job_number}` and does not call the private-message endpoint

#### Scenario: Generate a direct-message reply
- **WHEN** a new eligible Video Channels direct message is claimed for recruitment generation
- **THEN** the backend posts its unmodified text to `/agent/b2c/chat` with stable opaque `session_id` and `msg_id`, the saved `job_number`, `scenario="im"`, and `platform="视频号"`, and does not call the comment endpoint

#### Scenario: Change the recruitment job number
- **WHEN** an operator changes an account from one recruitment job number to another
- **THEN** subsequent direct messages use a new opaque upstream conversation scope and cannot inherit the old job's sticky conversation context

### Requirement: Intentional comment suppression
A successful recruitment comment response with an empty `reply` MUST be a terminal no-reply outcome and MUST NOT cause a Video Channels write.

#### Scenario: Recruitment service suppresses a comment
- **WHEN** the comment endpoint returns HTTP 200 with `reply` equal to an empty string
- **THEN** the Demo records the reply job as `skipped`, displays it as requiring no reply, and does not call the Video Channels send operation

### Requirement: Ordered direct-message bubbles
The Demo SHALL send every non-empty recruitment `content_list` element as a separate Video Channels text message in response order.

#### Scenario: Send multiple generated bubbles
- **WHEN** the direct-message endpoint returns two valid content items without an action
- **THEN** the Demo submits two distinct Video Channels text messages in the same order and confirms the reply job only after both platform receipts are present

#### Scenario: A later bubble cannot be confirmed
- **WHEN** at least one bubble has been submitted and a later bubble fails or has an ambiguous outcome
- **THEN** the Demo records the group as `submitted_unknown` and does not automatically replay the group

### Requirement: Unsupported actions fail before dispatch
The Demo MUST NOT send recruitment text that promises an action it cannot execute.

#### Scenario: Recruitment service requests a QR image
- **WHEN** a direct-message response contains `action="send_wechat_qr"`
- **THEN** the Demo fails the reply before sending any generated text and records a stable unsupported-action error

#### Scenario: Recruitment service requests human handoff
- **WHEN** a direct-message response contains `action="escalate_to_human"`
- **THEN** the Demo fails the reply before sending any generated text and records a stable unsupported-action error

### Requirement: No provider fallback
The Demo MUST expose a selected provider's generation failure and MUST NOT invoke another provider as a fallback.

#### Scenario: Recruitment request fails
- **WHEN** the selected recruitment request times out, returns a non-success status, exceeds the response limit, or violates its response schema
- **THEN** the reply job fails with a provider-specific error and the CHAT provider is not called

### Requirement: Provider-neutral public presentation
The operations page SHALL expose the selected reply mode without displaying the concrete CHAT model identifier or the recruitment service host.

#### Scenario: Render the provider switch
- **WHEN** an operator views an account snapshot
- **THEN** the page shows `CHAT回复` and `招聘接口` choices, the selected choice, and the account's job-number input without showing a concrete model name or upstream IP
