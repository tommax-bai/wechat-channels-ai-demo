## 1. Persist The Login Anchor

- [x] 1.1 Add the login-success timestamp column to `demo_sessions`, backfilled with the migration time for retained rows.
- [x] 1.2 Stamp the anchor in `completeAuthentication` so every successful login — first scan or re-scan — moves it to the current moment.
- [x] 1.3 Expose the anchor on the session row read by the workers.

## 2. Replace The Eligibility Rule

- [x] 2.1 Gate `persistPage` on "occurred at or after the anchor, within the 6-hour age cap" and delete the `baselineHistorical` and watermark branches, updating the comment that explains the brakes.
- [x] 2.2 Remove the watermark read (`latestInboundOccurredAt`) and the watermark computation in `syncSource`.
- [x] 2.3 Keep deduplication, the age cap, `automationEnabled`, and `authState` conditions unchanged — widened only so `baseline_sync` stores eligibility for a post-login item surfaced mid-baseline, since deduplication means no later poll will offer it again; dispatch still waits for the session to become active.

## 3. Regression Validation

- [x] 3.1 Replace watermark tests with anchor cases: a pre-login item stays historical; a post-login item older than the source's newest stored item is answered; a post-login item surfaced during an incomplete baseline is answered; a re-scan moves the anchor so logged-out-gap items stay historical.
- [x] 3.2 Keep the age-cap case independent of the anchor, as the watermark-era mutation testing required. The anchor is backdated 8 hours in that case so the 7-hour-old item is post-login and only the cap holds it.
- [x] 3.3 Verify the backfill: a retained row gets the migration time and its pre-deploy content stays historical on the first post-deploy poll; a never-authenticated row keeps a null anchor until its first login.
- [x] 3.4 Run lint, typecheck, the complete test suite, build, and `openspec validate anchor-auto-replies-to-login-time --strict`.

Test evidence (2026-08-11): 169 tests pass with lint, typecheck, build and strict validation clean. Two mutations each turned red only what was written for them: disabling the login anchor failed 21 cases (every baseline-historical and pre-login assertion), and disabling the age cap failed exactly the long-delayed case — the two brakes are independently tested. The fake gateway now stamps its baseline item one minute pre-login so the anchor, not the age cap, is what makes fixture history historical.

## 4. DEV Delivery And Live Acceptance

- [ ] 4.1 Back up DEV state, install the release, restart only the demo unit, and verify service and HTTPS health.
- [ ] 4.2 Verify on DEV that no retained account emits any reply at cutover, and that a fresh post-login message is answered within one polling interval.
