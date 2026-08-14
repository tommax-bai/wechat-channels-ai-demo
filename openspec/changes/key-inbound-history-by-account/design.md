# Design

## Messages belong to the account; containers are custodians

The unit that persists across logins is the WeChat account (`account_key_hash`), so the message table now keys rows, uniqueness, and the dedup hash namespace by account: `HMAC(inbound:acct:{account_key_hash}:{source}, externalId)`. A container discovering a message writes it into the account's ledger; any later container of the same account collides with that row and is ignored. This makes duplicate-reply protection structural — a stored message can never gain a second reply job because jobs are only created on first insert and `inbound_item_id` is unique — instead of resting solely on the login-time anchor's clock comparison. The anchor still decides eligibility for genuinely unseen items; the ledger now decides identity.

Dropping the `demo_sessions` cascade is what lets history outlive its discoverer. `session_id` stays on the row for two jobs only: provenance, and the encryption partition. Envelopes keep the AAD scope of the session that wrote them and are decrypted with the partition recorded on the row, so neither takeover nor migration ever re-encrypts a payload.

## Re-scan keeps the binding; completion decides

`beginQr` used to clear `account_key_hash` and delete the session's rows. Now it keeps the binding and touches no history: until a login actually completes, the account's ledger must stay owned, or the orphan sweep could eat it mid-relogin. Completion then rebinds the session — to the same account (ledger intact, overlap dedups) or to a different one, which strands the previous account's ledger for the sweep. An abandoned re-scan leaves through ordinary expiry, which orphans the ledger exactly when the account genuinely has no home left.

## Lifecycle: explicit ends, plus a sweep for everything else

Two paths end an account's history deliberately: deleting a holder session (logout) removes the account's rows in the same transaction, and the cleanup tick deletes rows whose account has no session row at all. The sweep covers every orphaning path — rebind, expired mid-relogin holder, crash timing — without needing markers, because "no session holds this account" is directly queryable. Retired rows are irrelevant to both: retirement already cleared their binding, and their discovered rows belong to the account, which the successor holds.

## Migration in two halves around the encryption key

The schema rebuild is pure SQL inside `openDatabase`: recreate both tables without session cascades, attribute rows through their session's `account_key_hash`, and drop rows whose session holds no account — those are either duplicates the holder also carries or leftovers of a disconnected account, and an unattributable row is worthless as a dedup entry. Re-keying the dedup hashes needs the encryption key, so it runs as a second step (`completeInboundAccountMigration`) wired into startup before the workers: each payload is decrypted with its recorded partition, its external ID re-hashed in the account namespace, and any undecryptable or colliding row dropped. `user_version` (1 = rebuilt, 2 = re-keyed) makes both halves crash-safe and one-time; a fresh database is born at 2.
