## 1. Account-Dimension Schema and Migration

- [x] 1.1 Rebuild `inbound_items` keyed by `account_key_hash` (account-scoped uniqueness, no session cascade, session_id kept as provenance and encryption partition) and `reply_jobs` without the session cascade
- [x] 1.2 Attribute legacy rows through their session's account, drop unattributable rows, and re-key every dedup hash into the `inbound:acct:{account}:{source}` namespace at startup before the workers poll, tracked by `user_version`

## 2. Account-Owned Ledger Behavior

- [x] 2.1 Persist and dedup inbound items in the account namespace; keep the account binding through `beginQr` and stop deleting history on re-scan
- [x] 2.2 Serve the UI timeline and Partner content by account, decrypting each envelope with the partition of the container that wrote it, and resolve reply records by inbound item alone
- [x] 2.3 Remove account history when its holder is explicitly deleted and sweep history whose account has no session row in the cleanup tick

## 3. Verification and Delivery

- [x] 3.1 Cover takeover ledger continuity and no-second-reply, mid-relogin retention, different-account rebind orphaning, holder deletion, and the legacy re-key migration in worker, integration, Partner, and migration regressions
- [x] 3.2 Run lint, typecheck, tests, build, and strict OpenSpec validation
  <!-- repo=wechat-channels-ai-demo; validation=npm run lint, npm run typecheck, vitest run (15 files, 180 tests), npm run build, openspec validate key-inbound-history-by-account --strict -->
- [ ] 3.3 Commit on the standalone main branch and record the integrated commit
- [ ] 3.4 Deploy the committed build to DEV, restart only the Demo service, and verify a real container change keeps the account timeline and answers nothing twice
