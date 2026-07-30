## 1. Repository and service foundation

- [x] 1.1 Add TypeScript package configuration, lint/typecheck/build/test scripts, and repository ignores
- [x] 1.2 Add validated environment configuration and safe startup diagnostics
- [x] 1.3 Add Fastify bootstrap, static asset serving, health endpoint, and graceful shutdown

## 2. Multi-account persistence and credential security

- [x] 2.1 Add SQLite migrations and repositories for demo sessions, encrypted platform credentials, source baselines, inbound items, replies, and events
- [x] 2.2 Implement opaque HttpOnly session cookies and session-scoped route guards
- [x] 2.3 Implement versioned AES-256-GCM credential envelopes with session-bound additional authenticated data
- [x] 2.4 Implement logout and retention cleanup that delete only the owning session scope

## 3. Browserless WeChat Channels authentication

- [x] 3.1 Implement bounded private-endpoint transport and explicit endpoint descriptors
- [x] 3.2 Implement QR creation and status polling with current success, scan, expiry, cancellation, and schema states
- [x] 3.3 Implement post-scan cookie capture, identity validation, helper UIN/private-message session capture, and encrypted persistence
- [x] 3.4 Add authenticated session status, QR refresh, stop/resume, and logout APIs

## 4. Inbound synchronization and baseline

- [x] 4.1 Implement bounded direct-message history parsing and normalized inbound records
- [x] 4.2 Implement bounded post/comment retrieval, post-identity-bound cursors, and normalized nested comment records with exact reply targets
- [x] 4.3 Implement source-specific historical baselines, incremental polling, own-message exclusion, and durable deduplication
- [x] 4.4 Implement per-source health and schema-change projection without credential-bearing diagnostics

## 5. AI generation and exact-target delivery

- [x] 5.1 Implement the injectable reply-model interface and Volcengine Ark provider for `doubao-seed-character-260628`
- [x] 5.2 Implement transactional reply-job claiming, bounded text generation, and visible model failures
- [x] 5.3 Implement exact-target direct-message and comment text sends with confirmed, failed, and `submitted_unknown` outcomes, per-session platform I/O serialization, and in-flight receipt retention
- [x] 5.4 Enforce per-session and service-wide automation stops before every new job claim

## 6. Customer demo experience

- [x] 6.1 Implement session snapshot and server-sent event routes
- [x] 6.2 Build the responsive QR/login, account, source-health, and interaction-timeline page
- [x] 6.3 Add real-time reconnect, stop/resume, logout, expiry, and transparent private-interface notices

## 7. Verification and handoff

- [x] 7.1 Add unit tests for encryption, session scoping, platform parsers, baselines, deduplication, model failures, and irreversible-send honesty
- [x] 7.2 Add integration tests with fake WeChat and Ark servers covering concurrent visitors and an end-to-end new-message reply
- [x] 7.3 Run the full test, typecheck, build, and OpenSpec strict-validation gates
- [x] 7.4 Add environment example, local runbook, Docker packaging, security limitations, and live-account validation checklist
- [x] 7.5 Commit the completed standalone repository and record validation evidence in this task file

## 8. DEV deployment

- [x] 8.1 Verify the named DEV target, existing service health, port availability, and HTTPS boundary without changing AIDCP or isales
- [x] 8.2 Add and commit the isolated systemd unit, environment template, runtime layout, validation, and rollback documentation
- [ ] 8.3 Install a checksum-verified private Node.js 22 runtime and deploy the committed source with production dependencies
- [ ] 8.4 Store fresh deployment secrets with restricted permissions and start only `wechat-channels-ai-demo.service`
- [ ] 8.5 Verify service health, browserless QR creation, exact Ark model access with synthetic text, restart persistence, and unchanged AIDCP/isales health
- [ ] 8.6 Record the deployed commit and honest public/live-account validation boundaries

## 9. Shared public demo follow-up

- [x] 9.1 Implement and integration-test a global list of logged-in sessions, visitor-selected account switching, and fresh account creation without replacing existing accounts
- [x] 9.2 Replace public model copy with `chat角色模型`, `chat-llm`, and `CHAT回复`, add a regression test that the concrete model ID is absent, and keep the exact server-side Ark model unchanged
- [x] 9.3 Align the browserless comment post-list request with the observed `userpageType=0` and `stickyOrder=false` parameters and cover the request contract in a platform-client test
- [x] 9.4 Add regression coverage for preserving SSE on compatible origins and using fixed five-second authoritative snapshot polling on `.trycloudflare.com`
- [ ] 9.5 Deploy the committed build behind a public HTTPS Quick Tunnel with Secure cookies while retaining the loopback-only application listener
- [ ] 9.6 Verify the public browser flow, global account switching, polling fallback, worker continuity after page closure, exact backend model access, and unchanged AIDCP/isales services

<!--
Initial validation 2026-07-30:
- npm run lint: pass
- npm run typecheck: pass
- npm test: 5 files, 29 tests passed
- npm run build: pass
- npm audit and npm audit --omit=dev: 0 vulnerabilities
- openspec validate build-multi-user-wechat-ai-demo --strict: pass
- In-app browser: real QR creation rendered without a browser engine in the service; authenticated SSE page, two-step logout, 204 deletion, and fresh anonymous session verified
- HTTP runtime smoke: health, isolated session creation, and two real QR refresh responses returned valid PNG data URLs
- Docker image build: not run because the local Docker daemon was unavailable
- Real post-scan WeChat DM/comment reads and sends: intentionally not performed; see docs/live-validation.md

Shared-demo follow-up validation 2026-07-30:
- npm test -- --run test/integration.test.ts test/platform-client.test.ts test/ui-copy.test.ts: 3 files, 26 tests passed
- openspec validate build-multi-user-wechat-ai-demo --strict: pass
- Commit SHA and public deployment evidence: pending parent integration and tasks 9.5-9.6
-->
