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

## 5. DEV Delivery And Live Acceptance

- [x] 5.1 Back up DEV state, install the release, configure the operator password, restart only the demo unit, and verify service and HTTPS health.
- [x] 5.2 Verify on DEV that the console is locked without the password, opens after the exchange, and that the connect page, the Partner API, and the retained accounts are unaffected.

DEV delivery evidence (2026-08-11): commit `4363a14` was installed as `/opt/wechat-channels-ai-demo/releases/4363a14` using Alibaba Cloud's npm mirror, passing the complete server-side check with 167 tests before activation. The previous release pointer (`releases/4537aff`), the root-owned environment and unit, and a WAL-consistent SQLite backup with `quick_check=ok` are retained at `/opt/wechat-channels-ai-demo/backups/pre-4363a14-20260811T043644Z`. The operator password was added to the root-owned `demo.env` only. Only the demo unit was restarted; it returned `active` with `NRestarts=0`, local health and readiness returned 200, `https://dev.yytt.com.cn/healthz` returned 200, and the `aidcp*` and `isales*` units kept their pre-deploy states.

Live acceptance (2026-08-11): without the ops cookie the console API answered `401 ops_auth_required`; a wrong password answered `401 ops_password_invalid` with no cookie; the correct password returned `204` with a `Secure; HttpOnly; SameSite=Lax` cookie whose value is not the password; with that cookie the account list returned every retained account unchanged (including 星禾2806, still `active` on the recruitment provider). `/connect` still answers 200 and an unauthenticated Partner request still answers its own `partner_api_unauthorized`. The console page serves the repositioned ops title.
