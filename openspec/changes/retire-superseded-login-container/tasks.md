## 1. Takeover Transaction

- [x] 1.1 Retire the current account holder inside the login-completion transaction: `logged_out` + `superseded_by_relogin`, released binding and persistence, bounded retirement expiry, successor link, queued replies failed as `account_superseded`, dead credentials deleted
- [x] 1.2 Carry the retired container's reply provider and funnel job number in the same transaction, and its business WeChat QR asset best-effort in the worker
- [x] 1.3 Remove the duplicate-login handoff record and the `account_already_connected` outcome

## 2. Browser Continuity

- [x] 2.1 Follow the bounded `linked_session_id` successor chain when a focused affinity or pending link names a retired container, refreshing the affinity cookie

## 3. Verification and Delivery

- [x] 3.1 Cover the takeover in worker, focused-connect, Partner, and integration regressions: successor state and inheritance, retired-row bookkeeping, failed queued replies, stale-affinity follow, retired Partner 404
- [x] 3.2 Run lint, typecheck, tests, build, and strict OpenSpec validation
  <!-- repo=wechat-channels-ai-demo; validation=npm run lint, npm run typecheck, vitest run (15 files, 176 tests), npm run build, openspec validate retire-superseded-login-container --strict -->
- [ ] 3.3 Commit on the standalone main branch and record the integrated commit
- [ ] 3.4 Deploy the committed build to DEV, restart only the Demo service, and verify a real re-scan of a retained account lands on its new container with the old one retired
