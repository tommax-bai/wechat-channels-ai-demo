## 1. Partner account defaults

- [x] 1.1 Share the server-side Funnel job default across focused and Partner account creation.
- [x] 1.2 Create new Partner accounts atomically with automation enabled, provider `funnel`, and the default job ID, while rejecting unconfigured Funnel without an orphan row.

## 2. Contract and coverage

- [x] 2.1 Add focused tests for the new Partner defaults, unavailable-Funnel failure, and unchanged browser-created defaults.
- [x] 2.2 Update Partner Markdown and OpenAPI documentation to describe the default enabled recruitment configuration.

## 3. Validation and delivery

- [x] 3.1 Run focused and full automated validation plus strict OpenSpec validation.
- [ ] 3.2 Commit and fast-forward clean `main`, deploy only the Demo service to DEV, and verify one temporary Partner account before deleting it.
