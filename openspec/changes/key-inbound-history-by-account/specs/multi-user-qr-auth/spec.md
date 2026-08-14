## MODIFIED Requirements

### Requirement: Latest completed login owns the platform account
The service SHALL host each WeChat Channels account in exactly one demo container and SHALL resolve a completed login for an already-hosted account by retiring the previous container and completing the new login, atomically. The account's message ledger SHALL follow the account, not the container: it survives re-scans and takeovers unchanged, and only an explicit deletion of the holding container or the account losing its last container removes it.

#### Scenario: Account re-logs in from a new container
- **WHEN** a platform login completes in one container for a Finder identity currently held by another container
- **THEN** the new container becomes the account's only hosting container with the freshly captured credentials
- **AND** the previous container is retired in the same transaction with the diagnosis `superseded_by_relogin` and a record of its successor

#### Scenario: Retired container stops all live activity
- **WHEN** a container is retired by a re-login
- **THEN** it leaves every retained listing and worker admission, its queued automatic replies fail as `account_superseded`, its dead platform credentials are deleted, and no send it initiated can be authorized afterwards

#### Scenario: Successor sees the account's full history
- **WHEN** a re-login retires a container that had discovered and answered messages for the account
- **THEN** the successor's timeline and content reads include those items with their reply records, and re-offered overlap dedups against them instead of being answered again

#### Scenario: Retired container leaves through ordinary cleanup
- **WHEN** a retired container reaches the standard transient-session retention deadline
- **THEN** the ordinary expired-session cleanup removes the container row without touching the account's message ledger or the successor

#### Scenario: Re-scan of a hosted container keeps the ledger
- **WHEN** the holding container starts a fresh login scan
- **THEN** the account binding and the account's message ledger are preserved through the pending scan, and a completed login for the same account resumes over the existing ledger

#### Scenario: Container rebinds to a different account
- **WHEN** the holding container's fresh scan completes for a different Finder identity
- **THEN** the container hosts the new account, and the previous account's ledger — now held by no container — is removed by the cleanup sweep

#### Scenario: Holding container is deleted
- **WHEN** the account's holding container is explicitly deleted
- **THEN** the account's message ledger is removed in the same transaction

#### Scenario: Successor inherits account-level reply configuration
- **WHEN** a re-login retires a container that had a reply provider, funnel job number, or business WeChat QR configured
- **THEN** the successor container carries that configuration forward without an explicit re-submission

#### Scenario: Interrupted takeover leaves the account intact
- **WHEN** the service halts between capturing a duplicate login and completing its persistence
- **THEN** the previous container remains the account's hosting container with its state unchanged
