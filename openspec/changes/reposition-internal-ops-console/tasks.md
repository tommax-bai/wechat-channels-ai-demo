# Tasks

## 1. Operator Login Gate

- [x] 1.1 Add optional `OPS_PASSWORD` (minimum 8 characters) to configuration, keep it out of the startup summary, and report only whether it is configured.
- [x] 1.2 Gate every `/api/*` console route behind an HttpOnly ops cookie when the password is configured, exempting `/api/connect/*` and the login route itself; `/partner/v1` and static pages are untouched by the gate.
- [x] 1.3 Add `POST /api/ops/login` exchanging the shared password for the cookie with a constant-time comparison; wrong passwords answer `401 ops_password_invalid` without a cookie.
- [x] 1.4 Show a login overlay on the console page when an API answers `ops_auth_required`, and resume normal refresh after a successful login.

## 2. Explicit-Only Account Creation

- [x] 2.1 Make `GET /api/session` read-only: without a resolvable selection it answers `401 demo_session_required` and creates nothing.
- [x] 2.2 Remove the visitor auto-create path (`ensureBrowserSession`); account sessions are created only by `POST /api/sessions/new`, the connect page, or the Partner API.
- [x] 2.3 Land the console on the account list by default and only enter the detail view for an explicitly selected account.

## 3. Console Reframing

- [x] 3.1 Replace demo copy with ops-console copy: title, hero, notice, footer, and "移除账号" for per-account removal; keep the reply-provider and business-QR copy contracts intact.
- [x] 3.2 Update README positioning, the configuration table, the route table, and `.env.example` for the internal-console model.

## 4. Regression Validation

- [x] 4.1 Cover the locked console, the wrong and correct password exchanges, a forged cookie, the exempt connect/partner surfaces, the open no-password mode, and the read that must not create a session.
- [x] 4.2 Rebase the test bootstrap helpers onto the explicit create route so existing flows keep their coverage.
- [x] 4.3 Run lint, typecheck, the complete test suite, build, and `openspec validate reposition-internal-ops-console --strict`.
