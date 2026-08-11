# ops-console-access

## ADDED Requirements

### Requirement: Shared operator login
When `OPS_PASSWORD` is configured, the service SHALL answer `401 ops_auth_required` on every console `/api` route until the browser presents the HttpOnly ops cookie issued by `POST /api/ops/login`, and the login exchange SHALL compare the submitted password in constant time without ever writing the password to a log, a response, or the cookie value. The customer-facing connect page with its `/api/connect` routes and the separately authenticated `/partner/v1` API SHALL remain outside the gate. When `OPS_PASSWORD` is absent, the console SHALL remain open.

#### Scenario: Console read without the ops cookie
- **WHEN** `OPS_PASSWORD` is configured and a request reaches a console `/api` route without a valid ops cookie
- **THEN** the service answers `401 ops_auth_required` and performs no session work

#### Scenario: Wrong password submitted
- **WHEN** `POST /api/ops/login` receives a password that does not match `OPS_PASSWORD`
- **THEN** the service answers `401 ops_password_invalid` and sets no cookie

#### Scenario: Correct password submitted
- **WHEN** `POST /api/ops/login` receives the configured password from the same origin
- **THEN** the service sets an HttpOnly ops cookie whose value is derived from the server encryption key and does not contain the password, and subsequent console requests with that cookie succeed

#### Scenario: Forged ops cookie presented
- **WHEN** a console request carries an ops cookie value the service did not derive
- **THEN** the service answers `401 ops_auth_required`

#### Scenario: Connect and partner surfaces stay reachable
- **WHEN** `OPS_PASSWORD` is configured and a request reaches `/connect`, an `/api/connect` route, or a `/partner/v1` route
- **THEN** the ops gate does not apply and the route keeps its own admission behavior

#### Scenario: No password configured
- **WHEN** `OPS_PASSWORD` is absent
- **THEN** console routes require no ops cookie

### Requirement: Explicit-only account session creation
The service SHALL NOT create an account session as a side effect of reading console state. Account sessions SHALL be created only by the explicit console add-account action, the connect page flow, or the Partner API.

#### Scenario: Reading state without a selection
- **WHEN** `GET /api/session` is called without a resolvable account selection
- **THEN** the service answers `401 demo_session_required`, sets no cookie, and stores no session row

#### Scenario: Operator adds an account
- **WHEN** the operator triggers the explicit add-account action
- **THEN** the service creates one account session bound to that browser and begins the QR login flow
