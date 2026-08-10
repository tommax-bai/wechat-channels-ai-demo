## Why

Partner API callers currently have to make two additional configuration requests after creating an account before it can use the recruitment reply flow. New Partner-created containers should match the Demo's intended default recruitment setup so scanning in is sufficient to start hosting after baseline initialization.

## What Changes

- Change newly created `/partner/v1/accounts` containers to persist automatic replies as enabled.
- Default those containers to the `funnel` reply provider and job ID `4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb`.
- Keep explicit reply-settings and hosting endpoints available for later overrides.
- Leave existing retained accounts and the browser Cookie APIs unchanged.
- Update Partner API documentation, OpenAPI examples, and automated coverage for the new defaults.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `partner-integration-api`: Change the initial hosting and reply settings of newly created Partner account containers.

## Impact

- Affects Partner account creation in `src/service/session-service.ts`, shared reply-default naming, Partner API projections/tests, and Partner integration documentation.
- No database migration or new dependency is required; the existing session columns already persist automation, provider, and job ID.
- New Partner accounts require the configured Funnel provider at creation time. Existing accounts retain their stored settings.
