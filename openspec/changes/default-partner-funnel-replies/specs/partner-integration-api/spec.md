## MODIFIED Requirements

### Requirement: Explicit account lifecycle
The service SHALL let an authenticated caller create, list, inspect, and delete retained account containers using an opaque `accountId`. A newly created Partner account SHALL persist automatic replies as enabled, reply provider `funnel`, and job ID `4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb`; these defaults SHALL NOT alter existing retained accounts.

#### Scenario: Create an account container
- **WHEN** the caller posts to `/partner/v1/accounts` while Funnel is configured
- **THEN** the service returns HTTP 201 with a new opaque account ID, automatic replies enabled, provider `funnel`, the default job ID, and its initial status without setting a browser Cookie

#### Scenario: Funnel is unavailable during account creation
- **WHEN** the caller posts to `/partner/v1/accounts` while Funnel is not configured
- **THEN** the service returns HTTP 503 with error code `funnel_provider_unavailable` and does not create an account container

#### Scenario: List accounts at every login stage
- **WHEN** the caller lists accounts
- **THEN** the response includes retained new, QR-pending, logged-in, paused, and platform-expired accounts but excludes deleted or logged-out accounts

#### Scenario: Unknown account
- **WHEN** an account-scoped call names an absent, deleted, logged-out, or no-longer-retained account
- **THEN** the service returns HTTP 404 with error code `partner_account_not_found`

#### Scenario: Delete account
- **WHEN** the caller deletes an account with no platform send in flight
- **THEN** the service removes its credentials and dependent content and returns HTTP 204
