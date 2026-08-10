## 1. Bounded Comment Polling

- [x] 1.1 Add an independent comment due-check heartbeat and durable 60-second per-source attempt-time gate while preserving the existing configured direct-message polling cadence and per-account serialization.
- [x] 1.2 Replace cursor-driven comment traversal with one post-list request, the first 3 posts, and one first-page comment request per selected post.
- [x] 1.3 Add the non-pagination comment observation marker, checkpoint it before comment reads, migrate valid v2 and completed legacy-null cursors as previously observed, and handle an unexpected empty post list as retryable.

## 2. Safe Source Recovery

- [x] 2.1 Recover only retained `schema_changed:post.cursor_target_missing` comment sources as incomplete historical baselines while preserving existing inbox and reply rows.
- [x] 2.2 Verify recovery cannot create reply jobs for comments first found during the recovery baseline and unrelated schema errors remain fail-closed.

## 3. Regression Validation

- [x] 3.1 Replace obsolete post/comment pagination tests with request-count, first-3-post, first-comment-page, deduplication, empty-list, and exact-target coverage.
- [x] 3.2 Run focused tests, the complete test suite, lint, typecheck, build, dependency audit, and `openspec validate bound-comment-polling --strict`.

## 4. DEV Delivery and Live Acceptance

- [ ] 4.1 Commit the change, integrate it into the clean standalone `main`, back up DEV state, deploy the new release, and verify service and HTTPS health.
- [ ] 4.2 Verify retained accounts attempt at most one bounded comment scan per 60 seconds, the affected source safely re-baselines, comments become visible when returned by WeChat, and the recovery baseline creates no automatic reply jobs.
