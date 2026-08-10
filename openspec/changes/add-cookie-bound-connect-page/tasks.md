## 1. Persistence and account resolution

- [x] 1.1 Add the additive `linked_session_id` SQLite migration and row mapping.
- [x] 1.2 Record and resolve duplicate-Finder authentication handoffs without replacing the retained account.
- [x] 1.3 Add migration and worker tests for new-account and existing-account authentication outcomes.

## 2. Focused server contract

- [x] 2.1 Serve `/connect` with no-store and the existing page security headers.
- [x] 2.2 Implement focused pending and affinity cookies plus automatic first-visit QR creation and later account restoration.
- [x] 2.3 Implement focused login refresh and account-bound business WeChat QR read/upload/delete endpoints.
- [x] 2.4 Add integration tests for first visit, repeat polling, new and duplicate Finder binding, invalid affinity recovery, and account-bound QR mutations.

## 3. Focused page

- [x] 3.1 Build the standalone responsive `/connect` markup and styling with only the two requested panels.
- [x] 3.2 Implement status polling, QR refresh, and business WeChat QR preview/upload/replace/delete interactions.
- [x] 3.3 Add UI contract tests proving requested copy and exclusion of dashboard controls.

## 4. Validation and delivery

- [x] 4.1 Run focused tests, the full test suite, lint, typecheck, and build.
- [x] 4.2 Validate the OpenSpec change strictly and reconcile task evidence.
- [x] 4.3 Visually verify `/connect` in a local browser at desktop and narrow viewport sizes.
- [ ] 4.4 Commit, fast-forward the clean main branch, deploy to DEV, and verify health plus the new page without restarting unrelated services.

## Evidence

- Repository/worktree: `/Users/baitianxing/codes/wechat-channels-ai-demo.wt/add-cookie-bound-connect-page` on `codex/add-cookie-bound-connect-page`.
- Automated validation: 14 test files / 149 tests passed; `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Browser validation: `/connect` rendered the requested two-panel QR state at the default desktop viewport and at 390 × 844; refresh produced a different login QR and browser console warning/error count was zero.
- Deployment: pending task 4.4.
