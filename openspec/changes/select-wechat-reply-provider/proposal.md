## Why

The standalone Video Channels Demo currently generates every reply through one process-wide CHAT model. The operator needs to choose, per logged-in Video Channels account, between that existing generator and a DEV-reachable recruitment-funnel service whose comment and direct-message contracts are different.

## What Changes

- Add an account-scoped, persistent reply-provider setting with `CHAT回复` and `招聘接口` choices.
- Require and persist a recruitment job number when the recruitment provider is selected.
- Call the recruitment service's comment endpoint only for comments and its B2C IM endpoint only for direct messages, entirely from the Demo backend.
- Treat an empty generated comment as an intentional no-reply outcome and send direct-message content bubbles in order as separate platform messages.
- Keep provider failures visible and never silently fall back to the other provider.
- Reject recruitment-service actions that the Demo cannot execute, including QR-image delivery and human handoff, before sending text that would falsely claim the action happened.
- Configure the recruitment service only in the DEV runtime that is allowed by its source-IP whitelist; retain the existing CHAT provider as the default for existing and new sessions.

## Capabilities

### New Capabilities

- `selectable-reply-generation`: Account-scoped provider selection, recruitment comment/DM request routing, output semantics, UI controls, and observable failure behavior.

### Modified Capabilities

None.

## Impact

- Affects the standalone Demo's SQLite session schema, reply model contract, background reply worker, session API/snapshot, and operations UI.
- Adds a server-side HTTP client for `http://115.190.239.42:9093`, configured by environment and invoked only from DEV.
- Adds no browser-to-upstream traffic, authentication header, external dependency, Video Channels media-send capability, or AIDCP runtime integration.
