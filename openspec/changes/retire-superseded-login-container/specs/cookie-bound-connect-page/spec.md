## MODIFIED Requirements

### Requirement: Completed focused login binds this browser
The service SHALL bind the focused browser to the container its pending login authenticated, whether or not the Finder identity was previously hosted elsewhere.

#### Scenario: Finder account already retained elsewhere
- **WHEN** a pending focused login completes for a Finder identity already owned by another retained container
- **THEN** the focused browser binds to its own newly authenticated container
- **AND** the previously retained container is retired with its reply settings and business WeChat QR carried onto the new one

### Requirement: Stale affinity follows the retirement handoff
The service SHALL resolve a focused affinity cookie that names a retired container by following the recorded successor chain to the account's live container and refreshing the cookie.

#### Scenario: Bound browser returns after a re-login elsewhere
- **WHEN** a browser presents an affinity cookie for a container retired by a later re-login
- **THEN** the focused status responds with the successor container's account state
- **AND** replaces the affinity cookie with the successor's identifier

#### Scenario: Successor chain is exhausted
- **WHEN** a retired container's recorded successor has itself been removed
- **THEN** the service clears the stale affinity and starts one fresh pending login
