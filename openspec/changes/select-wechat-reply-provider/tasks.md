## 1. Provider Contract and Persistence

- [x] 1.1 Add provider/result types, DEV-only funnel configuration, safe startup/readiness projection, and a non-destructive SQLite migration for per-session provider and job number.
- [x] 1.2 Implement the bounded funnel adapter with strict comment/DM request routing, response validation, stable request evidence, intentional skip, and unsupported-action rejection.

## 2. Account Settings and Operations UI

- [x] 2.1 Add repository and session-service provider persistence plus a same-origin account settings endpoint with provider-availability and job-number admission.
- [x] 2.2 Add the `CHAT回复` / `招聘接口` switch and per-account job-number editor without exposing the concrete CHAT model or funnel host.

## 3. Reply Execution Semantics

- [x] 3.1 Select the configured provider at generation time and derive stable opaque funnel DM session/message identifiers without fallback.
- [x] 3.2 Handle skipped comments, ordered multi-bubble DM dispatch, per-bubble authorization, aggregate receipts, and honest partial-send outcomes while preserving old encrypted reply results.

## 4. Automated Validation

- [x] 4.1 Add funnel adapter tests for endpoint separation, exact payloads, empty comments, multi-bubble output, actions, timeouts, size limits, status failures, and malformed responses.
- [x] 4.2 Add migration, configuration, account-setting, worker integration, partial-send, no-fallback, and UI-copy regression coverage.
- [x] 4.3 Run focused tests, full `npm run check`, dependency audit, and `openspec validate select-wechat-reply-provider --strict`.

## 5. Integration and DEV Release

- [ ] 5.1 Commit the isolated change, integrate it into clean standalone `main`, and record that the repository has no configured remote if push remains unavailable.
- [ ] 5.2 Back up the independent DEV release, environment, unit, and SQLite data; configure the funnel base URL/timeout without exposing existing secrets; deploy from clean `main` and restart only `wechat-channels-ai-demo.service`.
- [ ] 5.3 Verify DEV upstream allowlist health, Demo service/HTTPS health, database migration, retained account sessions, provider-setting readback, source-specific adapter behavior, and no impact/restart to AIDCP or isales services; record exact evidence and any remaining real-write gate.
