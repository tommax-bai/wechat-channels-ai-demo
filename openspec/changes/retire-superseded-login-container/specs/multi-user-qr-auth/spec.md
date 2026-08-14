## MODIFIED Requirements

### Requirement: Latest completed login owns the platform account
The service SHALL host each WeChat Channels account in exactly one demo container and SHALL resolve a completed login for an already-hosted account by retiring the previous container and completing the new login, atomically.

#### Scenario: Account re-logs in from a new container
- **WHEN** a platform login completes in one container for a Finder identity currently held by another container
- **THEN** the new container becomes the account's only hosting container with the freshly captured credentials
- **AND** the previous container is retired in the same transaction with the diagnosis `superseded_by_relogin` and a record of its successor

#### Scenario: Retired container stops all live activity
- **WHEN** a container is retired by a re-login
- **THEN** it leaves every retained listing and worker admission, its queued automatic replies fail as `account_superseded`, its dead platform credentials are deleted, and no send it initiated can be authorized afterwards

#### Scenario: Retired container leaves through ordinary cleanup
- **WHEN** a retired container reaches the standard transient-session retention deadline
- **THEN** the ordinary expired-session cleanup removes it and its owned history without touching the successor

#### Scenario: Successor inherits account-level reply configuration
- **WHEN** a re-login retires a container that had a reply provider, funnel job number, or business WeChat QR configured
- **THEN** the successor container carries that configuration forward without an explicit re-submission

#### Scenario: Interrupted takeover leaves the account intact
- **WHEN** the service halts between capturing a duplicate login and completing its persistence
- **THEN** the previous container remains the account's hosting container with its state unchanged
