## 1. Read Increments From The Proven Endpoint

- [ ] 1.1 Read every direct-message poll from the history endpoint, keeping baseline pagination and reading only the first page once the baseline is complete.
- [ ] 1.2 Stop calling the notify and login-cookie endpoints from the synchronization path, and drop the now-meaningless `dmCursor` field from the platform session.
- [ ] 1.3 Migrate a retained v1 cursor on read: keep its phase, discard its token, and never replay it against a different endpoint.

## 2. Reply Eligibility Brakes

- [ ] 2.1 Add a reply watermark from the newest stored item for the source, and store anything older as historical.
- [ ] 2.2 Add a 6-hour maximum automatic-reply age so a recovered blind lane cannot answer a backlog at once.
- [ ] 2.3 Keep both brakes out of the baseline path, where every item is historical already.

## 3. Regression Validation

- [ ] 3.1 Cover the baseline walking pages and then re-reading only the first page, a retained notify cursor still reading history, the watermark blocking an older unseen item, and the age cap blocking a stale one.
- [ ] 3.2 Replace the tests that covered the retired notify and login-cookie path rather than leaving them asserting code that no longer runs.
- [ ] 3.3 Run lint, typecheck, the complete test suite, build, and `openspec validate read-dm-increments-from-history --strict`.

## 4. DEV Delivery And Live Acceptance

- [ ] 4.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health.
- [ ] 4.2 Verify on DEV that the account whose message was missed now stores it and answers it, and that no other account emits a burst of replies to old content.
