## MODIFIED Requirements

### Requirement: Fresh Partner account can re-login a hosted Finder identity
The service SHALL complete a Partner-initiated QR login even when the scanned Finder identity is already hosted by another container, by handing the account to the Partner account that completed the login.

#### Scenario: Funnel backend re-logs in an already-hosted account
- **WHEN** a Partner client creates a new account, requests its login QR, and the QR is scanned by a Finder identity another container currently hosts
- **THEN** the login status of the new Partner account reports success and its projection carries the account's previous reply provider and job number

#### Scenario: Retired Partner account disappears from the Partner surface
- **WHEN** a container is retired by such a takeover
- **THEN** it is absent from the Partner account listing and resolving it returns `partner_account_not_found`
