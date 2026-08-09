## 1. Account QR persistence and settings

- [x] 1.1 Add the idempotent encrypted account QR asset schema, repository accessors, and strict PNG/JPEG data-URL validation.
- [x] 1.2 Add SessionService QR read/write/delete operations and project QR metadata through session and shared-account snapshots.
- [x] 1.3 Add same-origin Demo endpoints and authenticated Partner endpoints for QR configuration, replacement, inspection, and removal.

## 2. Funnel action and Video Channels media transport

- [x] 2.1 Extend reply output with the `send_wechat_qr` action and update Funnel parsing while preserving unsupported-action failures.
- [x] 2.2 Add the official-bundle-backed `upload-media-info` request descriptor, 512 KiB upload flow, and `msgType: 3` private-message send with `svrMsgId` confirmation.
- [x] 2.3 Orchestrate text bubbles followed by the account QR, including pre-dispatch asset checks, unique client IDs, receipt hashing, and honest partial/ambiguous outcomes.

## 3. Demo and Partner surfaces

- [x] 3.1 Add per-account QR upload, preview, replacement, and removal controls to the Demo page with bounded client-side validation.
- [x] 3.2 Document the Partner QR endpoints and schemas in Markdown and OpenAPI without exposing image bytes in account projections.

## 4. Verification and delivery

- [x] 4.1 Add migration, repository/service, API, Funnel, platform-gateway, worker integration, and UI-copy tests for the new contract.
- [x] 4.2 Run focused tests, full check, `git diff --check`, and `openspec validate send-account-qr-for-funnel-action --strict`.
- [x] 4.3 Record implementation evidence and the explicit live-send validation boundary in this checklist and `docs/live-validation.md`.
- [ ] 4.4 Integrate the clean feature branch into `main`, deploy only `wechat-channels-ai-demo.service` to DEV, and verify HTTPS health, readiness, existing account state, QR configuration metadata, and service restart count without sending a real message.

Implementation evidence (2026-08-09): `npm run check` passed lint, typecheck, 121 tests, and build; `git diff --check` passed; strict OpenSpec validation passed. Automated tests cover encrypted per-account assets, API non-disclosure, cross-tab account binding, Funnel actions, media request shapes, ordered dispatch, QR replacement/deletion races, missing configuration, and partial/ambiguous outcomes. `docs/live-validation.md` keeps recipient-visible image delivery behind an explicitly approved disposable conversation; no real account message was sent during implementation.
