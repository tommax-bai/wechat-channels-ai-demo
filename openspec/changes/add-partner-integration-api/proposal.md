## Why

The Demo currently exposes only a same-origin, browser-cookie API, so another application cannot safely create and manage its own login flow or render account content. A stable server-to-server contract is needed for a colleague's backend to integrate QR login, reply selection, hosting state, comments, and direct messages without coupling to the Demo UI.

## What Changes

- Add a versioned `/partner/v1` REST API protected by a dedicated Bearer API key and explicit account identifiers.
- Add account creation/list/detail/deletion, QR login creation and status, and distinct login-scan, login-success, and hosting-expiry state.
- Add reply-provider and job-number selection without exposing concrete model names or upstream Funnel details.
- Add separate, cursor-paginated comment and direct-message reads, including asynchronous reply state.
- Publish human-readable integration documentation and a machine-readable OpenAPI contract.
- Keep the existing browser Cookie API and Demo page behavior unchanged.

## Capabilities

### New Capabilities

- `partner-integration-api`: Authenticated external account lifecycle, QR login, hosting and reply settings, separated content reads, error semantics, and documentation.

### Modified Capabilities

None.

## Impact

- Affects HTTP routing, configuration, session/service projections, SQLite read queries, tests, and deployment environment documentation in `wechat-channels-ai-demo`.
- Adds one deployment secret, `PARTNER_API_KEY`; it must never be exposed to browser code, logs, health output, or API responses.
- Reuses the existing WeChat workers and persisted login authority; it does not add a second polling or reply pipeline.
- The Funnel service has no job catalogue endpoint, so callers select a pre-existing `jobNumber`; catalogue discovery is explicitly outside this change.
