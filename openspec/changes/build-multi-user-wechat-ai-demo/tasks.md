## 1. Repository and service foundation

- [x] 1.1 Add TypeScript package configuration, lint/typecheck/build/test scripts, and repository ignores
- [x] 1.2 Add validated environment configuration and safe startup diagnostics
- [x] 1.3 Add Fastify bootstrap, static asset serving, health endpoint, and graceful shutdown

## 2. Multi-user persistence and credential security

- [x] 2.1 Add SQLite migrations and repositories for demo sessions, encrypted platform credentials, source baselines, inbound items, replies, and events
- [x] 2.2 Implement opaque HttpOnly session cookies and tenant-scoped route guards
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

- [x] 6.1 Implement authenticated session snapshot and server-sent event routes
- [x] 6.2 Build the responsive QR/login, account, source-health, and interaction-timeline page
- [x] 6.3 Add real-time reconnect, stop/resume, logout, expiry, and transparent private-interface notices

## 7. Verification and handoff

- [x] 7.1 Add unit tests for encryption, session isolation, platform parsers, baselines, deduplication, model failures, and irreversible-send honesty
- [x] 7.2 Add integration tests with fake WeChat and Ark servers covering concurrent visitors and an end-to-end new-message reply
- [x] 7.3 Run the full test, typecheck, build, and OpenSpec strict-validation gates
- [x] 7.4 Add environment example, local runbook, Docker packaging, security limitations, and live-account validation checklist
- [x] 7.5 Commit the completed standalone repository and record validation evidence in this task file

<!--
Validation 2026-07-30:
- npm run lint: pass
- npm run typecheck: pass
- npm test: 4 files, 27 tests passed
- npm run build: pass
- npm audit and npm audit --omit=dev: 0 vulnerabilities
- openspec validate build-multi-user-wechat-ai-demo --strict: pass
- In-app browser: real QR creation rendered without a browser engine in the service; authenticated SSE page, two-step logout, 204 deletion, and fresh anonymous session verified
- HTTP runtime smoke: health, isolated session creation, and two real QR refresh responses returned valid PNG data URLs
- Docker image build: not run because the local Docker daemon was unavailable
- Real post-scan WeChat DM/comment reads and sends: intentionally not performed; see docs/live-validation.md
-->
