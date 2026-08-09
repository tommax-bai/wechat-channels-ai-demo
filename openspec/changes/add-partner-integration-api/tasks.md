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

- [ ] 5.1 Commit the feature worktree, fast-forward the canonical main checkout, and record integration evidence
- [ ] 5.2 Back up and deploy only the independent Demo service to DEV with a non-disclosed Partner key
- [ ] 5.3 Verify public health, Partner authentication/account API, existing browser API, and unrelated DEV service stability
