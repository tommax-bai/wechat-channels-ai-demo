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
- [x] 3.3 Commit on the standalone main branch and record the integrated commit
  <!-- repo=wechat-channels-ai-demo; integrated_commit=34b097f; branch=main; remote=not_configured; parent=72c466e -->
- [ ] 3.4 Deploy the committed build to DEV, restart only the Demo service, and verify a real re-scan of a retained account lands on its new container with the old one retired
  <!-- target=dev; release=/opt/wechat-channels-ai-demo/releases/34b097f; previous=/opt/wechat-channels-ai-demo/releases/a0b7bdc; validation=server-side npm run check (15 files, 176 tests) before activation; post-restart service active, local /healthz and /readyz ok, public https://dev.yytt.com.cn/healthz ok, pre/post DB counts preserved at 5 sessions / 30 inbound / 0 reply jobs / 3 QR assets, active account J8pYEcgU intact, nginx and aidcp units active; live re-scan acceptance still pending the next real duplicate login -->

