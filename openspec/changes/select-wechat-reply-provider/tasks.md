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

- [x] 5.1 Commit the isolated change as `3587051`, fast-forward it into clean standalone `main`, and record that this repository has no configured remote, so no push target exists.
- [x] 5.2 Back up the independent DEV release pointer, environment, systemd unit, and integrity-checked SQLite database under `/opt/wechat-channels-ai-demo/backups/20260808-125009-before-5757f07`; configure only the funnel base URL/timeout keys; install commit `5757f07` with the Alibaba Cloud npm mirror; run the full server-side check; switch the release pointer; and restart only `wechat-channels-ai-demo.service`.
- [x] 5.3 Verify DEV upstream health returned HTTP 200 from `115.190.239.42` with `openchat/healthy` and one request ID; public HTTP redirects to HTTPS and public health/readiness report both providers configured; SQLite contains both new columns and preserves the one retained `auth_required` account on `chat-llm`; a disposable settings probe returned CHAT readback, rejected funnel without a job number, and was deleted; the deployed 84-test suite proves source-specific endpoint/payload behavior; browser validation proves the switch and job-number admission without public model/host details; Demo, AIDCP, and isales units retained their expected states with zero restart count. No valid recruitment `job_number` was supplied, so one authorized new comment and DM remain the explicit gate for real upstream generation and Video Channels write acceptance.
