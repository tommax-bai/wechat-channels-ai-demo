# Live validation checklist

Automated tests prove the local service contract, encryption, baseline behavior, idempotency and send-outcome handling. They do not prove that the current private WeChat Channels endpoints accept the one-time browser-assisted login bootstrap or return the known live comments.

Run these stages in order against an explicitly selected Demo account. Stop at the first failed gate.

## 1. Deployment and custody

- [ ] HTTPS terminates at `https://dev.yytt.com.cn`; HTTP redirects to HTTPS,
  and only the dedicated Demo server blocks proxy to the loopback listener.
- [ ] `SESSION_ENCRYPTION_KEY` is unique to this deployment and is not logged or committed.
- [ ] `ARK_API_KEY` belongs to the Demo environment.
- [ ] The exact `ARK_MODEL` is accepted by that key; `ModelNotOpen` is shown as failure and no other model is substituted.
- [ ] The operator confirms the customer-facing private-interface and credential-custody notice.

## 2. QR authentication and bounded context capture

- [ ] Request a QR and verify no Chrome process is launched before scan confirmation.
- [ ] Scan and confirm one QR.
- [ ] Confirm login polling reaches the platform-confirmed state.
- [ ] Confirm one isolated Chrome process imports only that session's WeChat cookies and captures an exact first-party `/auth/auth_data` request.
- [ ] Confirm the captured Finder identity matches the scanned Finder identity.
- [ ] Confirm Chrome closes before the session enters baseline synchronization.
- [ ] Confirm the helper endpoint returns the UIN.
- [ ] Restart the service and confirm the encrypted session can be reused.
- [ ] Log out and confirm the credential and session-owned rows are deleted.
- [ ] Attempt the same Finder identity from a second Demo browser and confirm the second binding is rejected without identifying the first visitor.

## 3. Read-only source validation

- [ ] Direct-message history returns a valid empty or non-empty bounded shape.
- [ ] `get-login-cookie` returns a DM cursor distinct from the HTTP CookieJar.
- [ ] `get-new-msg` advances the cursor only after parsing and persistence succeed.
- [ ] `get-session-info` resolves the sender of a non-empty DM.
- [ ] Post list returns both `objectId` and `exportId`.
- [ ] Comment list uses `exportId`, returns a stable `commentId`, and preserves the complete reply target object.
- [ ] Reorder the post-list fixture between comment pages and confirm the durable cursor remains bound to the same `objectId/exportId`; removing that post must fail closed.
- [ ] A second-level comment with complete exact context is normalized as its own inbound item with the root ID, its own parent ID, and a write context whose `levelTwoComment` is empty.
- [ ] A slim comment without complete write context is skipped and never queued for reply, while valid sibling and child nodes continue to synchronize.
- [ ] A multi-page post/comment fixture drains every advertised continuation cursor before the baseline becomes complete.
- [ ] Existing content appears as historical and creates zero reply jobs.
- [ ] A new text item after baseline creates exactly one queued reply job.

## 4. Controlled write validation

This stage requires a separately approved disposable direct-message conversation and comment.

- [ ] Disable `DEMO_AUTO_REPLY_ENABLED` before preparing the targets.
- [ ] Verify the exact account, conversation/post, sender, and disposable item.
- [ ] Enable automatic reply and create one new inbound DM.
- [ ] Confirm the model uses exactly `doubao-seed-character-260628`.
- [ ] Confirm the send response includes a non-empty `svrMsgId`.
- [ ] Read back the conversation and verify the reply is visible.
- [ ] Repeat once for a top-level comment and require a non-empty returned `commentId`.
- [ ] Read back the comment and verify it is visible under the exact parent.
- [ ] Repeat once for a disposable second-level comment and verify the reply is attached to that exact comment.
- [ ] Simulate a send timeout and confirm the job becomes `submitted_unknown` with no automatic retry.
- [ ] Stop or log out while generation is in progress and confirm a not-yet-dispatched request never reaches the platform.
- [ ] Refresh the QR and request logout while a dispatched send is awaiting its receipt; both mutations must return `platform_send_in_flight`, and the terminal receipt must remain visible before retrying.
- [ ] Run sync and send concurrently while the fixture rotates different cookies; the persisted CookieJar must retain both updates.
- [ ] Treat any write already dispatched before logout as irreversible; reconcile it by platform read-back rather than retry.

## 5. Delivery boundary

Only after all applicable checks pass may the Demo be described as “QR login, one-time browser-assisted comment bootstrap, and automatic reply verified for the named Demo account on the validation date.” It must not be described as fully browserless, official, stable, or generally production-ready.
