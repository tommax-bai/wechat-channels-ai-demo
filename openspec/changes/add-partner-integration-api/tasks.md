## 1. Configuration and API boundary

- [x] 1.1 Add optional validated Partner API configuration and safe readiness/startup projection
- [x] 1.2 Add constant-time Bearer authentication, Partner response headers, and stable error mapping

## 2. Account and status projection

- [x] 2.1 Add Partner-created disabled sessions and retained-account listing
- [x] 2.2 Implement account, QR/login, hosting, provider/job, and deletion endpoints with explicit account IDs
- [x] 2.3 Implement public login, hosting, source, and reply-settings projections without sensitive internal fields

## 3. Content reads

- [x] 3.1 Add source-specific keyset pagination and its supporting SQLite index
- [x] 3.2 Add normalized comment and direct-message DTOs with current reply state and multi-message output

## 4. Contract and tests

- [x] 4.1 Add focused configuration, authentication, lifecycle, status, provider/job, content, pagination, and regression tests
- [x] 4.2 Publish Markdown integration documentation and matching OpenAPI YAML, then align example environment and README references
- [x] 4.3 Run focused tests, full repository checks, strict OpenSpec validation, and security review

## 5. Integration and DEV delivery

- [x] 5.1 Commit the feature worktree, fast-forward the canonical main checkout, and record integration evidence
- [x] 5.2 Back up and deploy only the independent Demo service to DEV with a non-disclosed Partner key
- [x] 5.3 Verify public health, Partner authentication/account API, existing browser API, and unrelated DEV service stability

## Evidence

- Feature and fast-forward integration: repository `wechat-channels-ai-demo`, commit `8d8d10a8996eb4418eb275842050351e510f3925` on `main`.
- Pre-integration validation: `npm run check` passed with 10 test files and 92 tests; `openspec validate add-partner-integration-api --strict` and both read-only reviews passed with no remaining P0-P2 findings.
- DEV deployment: clean `main` commit `f64373915be6ef07b960d9c899a6490d134baafc` installed as `/opt/wechat-channels-ai-demo/releases/f643739`; previous release `5757f07` and release/env/unit/SQLite backup retained at `/opt/wechat-channels-ai-demo/backups/20260809T043405Z`.
- Deployment secret: a new 64-character Partner credential was generated and retained only in the root-owned mode-0600 DEV environment; no credential value was logged or committed.
- Deployment deviation: the first install in the inactive new release inherited system Node 20 and failed before switching; it was rerun successfully with the isolated Node 22 runtime and Alibaba npm mirror. The old live release remained active throughout.
- DEV acceptance: remote `npm run check` passed 92 tests; HTTPS health/readiness returned 200; unauthenticated Partner access returned 401; an authenticated temporary account completed create/list/provider+job selection/QR/status/hosting/empty comment+DM reads/delete with a 404 deletion postcondition; SQLite integrity was `ok` and the source pagination index existed.
- Isolation postcondition: only `wechat-channels-ai-demo.service` was restarted. Demo, Nginx, `aidcp-api`, `aidcp-automation`, `aidcp-content`, and all four `isales` units were active with `NRestarts=0`; Funnel health remained 200.
