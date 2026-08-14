# Proposal

## Why

Inbound history has been a property of the container: dedup keys, feed queries, and row lifetime all hung off the demo session that discovered a message. Every container change therefore restarted the account's story from zero — a re-scan deleted the session's rows outright, and a takeover stranded them on the retired row until the retention cascade removed them. The same platform message re-offered to the account's next container was a stranger to everything already stored, so duplicate automatic replies were prevented only by the login-time anchor, a clock comparison between the platform's message timestamps and this service's login stamp. The operator wants message history to belong to the WeChat account so it survives container turnover, and wants duplicate-reply protection to rest on message identity rather than on clocks alone.

## What Changes

- `inbound_items` is keyed by the account: rows carry `account_key_hash`, uniqueness and the dedup hash namespace move from the session to the account, and the session cascade is gone — `session_id` remains only as provenance and as the envelope's encryption partition. `reply_jobs` likewise stops cascading from `demo_sessions` (it still dies with its inbound item).
- A container takeover hands the successor the entire ledger implicitly: its baseline dedups against what any earlier container stored instead of re-inserting, no reply job can be recreated for an already-stored message, and the UI timeline and Partner content endpoints — now account-scoped — keep showing predecessor rows with their reply records.
- A re-scan (`beginQr`) keeps the session's account binding and no longer deletes history; completion rebinds the session, and only rebinding to a different account orphans the previous ledger.
- Account history has an explicit lifecycle: deleting a holder session removes its account's history in the same transaction, and the cleanup tick sweeps history whose account no longer has any session row.
- A startup migration rebuilds the legacy tables, attributes each row to its session's account, drops unattributable rows, and — before any sync worker polls — re-keys every dedup hash from the decrypted payload's external ID into the account namespace.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wechat-inbound-sync`: deduplication is durable within the owning WeChat account rather than the discovering demo session, so container turnover cannot re-answer already-stored messages; orphaned account history is removed once no session hosts the account.
- `multi-user-qr-auth`: a re-login (same container or takeover) preserves the account's message ledger; a retired container leaves through cleanup without taking the account's history; an explicit holder logout removes it.
- `partner-integration-api`: content endpoints serve the account's ledger, including rows discovered by a predecessor container, with unchanged response shape.

## Impact

- Schema rebuild of `inbound_items` and `reply_jobs` with a `user_version` marker and a keyed re-hash step wired into startup (`main.ts`) ahead of the workers.
- Repository inbound read/write paths, `beginQr`, `deleteSession`, and a new orphan-history sweep; sync persistence and cleanup workers; session snapshot and Partner content projection.
- Existing regressions updated for retained history; new coverage for takeover dedup, mid-relogin retention, rebind orphaning, holder deletion, and the legacy re-key migration.
