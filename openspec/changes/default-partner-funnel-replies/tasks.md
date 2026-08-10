## 1. Partner account defaults

- [x] 1.1 Share the server-side Funnel job default across focused and Partner account creation.
- [x] 1.2 Create new Partner accounts atomically with automation enabled, provider `funnel`, and the default job ID, while rejecting unconfigured Funnel without an orphan row.

## 2. Contract and coverage

- [x] 2.1 Add focused tests for the new Partner defaults, unavailable-Funnel failure, and unchanged browser-created defaults.
- [x] 2.2 Update Partner Markdown and OpenAPI documentation to describe the default enabled recruitment configuration.

## 3. Validation and delivery

- [x] 3.1 Run focused and full automated validation plus strict OpenSpec validation.
- [x] 3.2 Commit and fast-forward clean `main`, deploy only the Demo service to DEV, and verify one temporary Partner account before deleting it.

## Evidence

- Code delivery: commit `3ba9580` was fast-forwarded into clean standalone `main`; no remote is configured for this repository.
- Local validation: 14 test files / 153 tests, lint, typecheck, build, `git diff --check`, and strict OpenSpec validation passed.
- DEV release validation: Alibaba Cloud's npm mirror install plus the complete `npm run check` passed in `/opt/wechat-channels-ai-demo/releases/3ba9580` before activation.
- DEV backup: the previous release, root-owned mode-0600 environment, systemd unit, and WAL-consistent SQLite backup with `quick_check=ok` are retained at `/opt/wechat-channels-ai-demo/backups/20260810T083459Z-before-3ba9580`.
- Live Partner acceptance: one authenticated, unscanned temporary account returned and persisted automation enabled, provider `funnel`, and job ID `4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb`; it was deleted immediately, a follow-up GET returned 404, and the session count returned from 5 to 5.
- DEV postcondition: release `3ba9580` is active with `NRestarts=0`; public health/readiness pass, HTTP redirects to HTTPS, SQLite remains `quick_check=ok` with `5 sessions / 69 inbound / 11 replies / 3 QR assets` and the pre-deploy provider distribution unchanged. Nginx, all three AIDCP units, and all four isales units remain active with `NRestarts=0`; the Demo emitted no warning/error lines during the final deployment window.
