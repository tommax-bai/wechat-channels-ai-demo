## 1. Session Persistence

- [x] 1.1 Add an additive authenticated-session persistence marker and migrate existing authenticated rows without resetting encrypted credentials
- [x] 1.2 Update session creation, QR refresh, retention queries, cleanup, worker admission, and send guards so only unauthenticated sessions use a local cleanup deadline
- [x] 1.3 Project explicit platform authentication failures from synchronization and unambiguous sends into the re-login state

## 2. Configuration and UI

- [x] 2.1 Separate unauthenticated cleanup retention from the browser selector cookie lifetime and remove the absolute authenticated-session TTL setting from examples
- [x] 2.2 Remove authenticated-session expiry from API projections and replace public expiry copy with platform-authoritative login-state copy
- [x] 2.3 Update README and deployment documentation for persistent authenticated sessions and fresh-QR recovery

## 3. Verification and Delivery

- [x] 3.1 Add regressions for existing-row migration, post-deadline worker continuity, unauthenticated cleanup, public projection, and explicit platform auth rejection
- [x] 3.2 Run lint, typecheck, tests, build, audit, and strict OpenSpec validation
  <!-- repo=wechat-channels-ai-demo; validation=npm run check (8 files, 63 tests), npm audit --audit-level=high (0 vulnerabilities), openspec validate preserve-demo-login-until-platform-expiry --strict -->
- [x] 3.3 Commit and fast-forward the standalone main branch, then record the integrated commit and validation evidence
  <!-- repo=wechat-channels-ai-demo; integrated_commit=759b89a2375abf65f6338f53130a0924d4ec4673; branch=main; remote=not_configured -->
- [ ] 3.4 Back up and deploy the clean committed main build to DEV, restart only the Demo service, and verify the retained account plus public HTTPS behavior
