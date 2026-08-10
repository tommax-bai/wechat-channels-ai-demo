## Context

`POST /partner/v1/accounts` currently calls `createPartnerSession`, which inserts a session with automatic replies disabled and relies on SQLite defaults for `chat-llm` and a null Funnel job. The focused `/connect` path separately selects Funnel and the requested job after session creation. Partner callers now require the same recruitment defaults without extra setup requests.

## Goals / Non-Goals

**Goals:**

- Persist enabled automation, provider `funnel`, and the requested job in every newly created Partner account.
- Keep session creation atomic so a successful HTTP 201 already contains the complete default configuration.
- Fail before creating a container when Funnel is not configured.
- Preserve explicit Partner overrides and all existing account settings.

**Non-Goals:**

- Changing existing retained accounts.
- Automatically enabling browser-created dashboard accounts.
- Changing the focused `/connect` user experience, worker scheduling, Funnel contracts, or job validation.
- Adding a mutable deployment setting for the requested fixed default job.

## Decisions

### Share one server-side default job constant

Rename the connect-specific server constant to a shared reply default and use it from both `/connect` and Partner account creation. This prevents the two server creation paths from drifting while leaving the existing browser-side display constant unchanged.

### Insert the complete Partner default atomically

Extend the repository session-creation operation with optional initial provider and job fields. Normal browser sessions keep the existing `chat-llm` and null-job defaults; Partner sessions pass `automationEnabled=true`, provider `funnel`, and the shared job ID in the initial insert.

This is preferred over creating a disabled CHAT account and then issuing two updates because an interruption between writes could expose a partial container through `GET /accounts`.

### Reject Partner creation when Funnel is unavailable

`createPartnerSession` checks the configured Funnel base URL before inserting the account. A missing provider returns the existing `funnel_provider_unavailable` error as HTTP 503 and creates no retained row. There is no fallback to CHAT because that would contradict the requested default.

Automation is persisted as enabled at creation, but it becomes effective only after QR login, source baseline completion, the global service switch, and provider availability satisfy the existing hosting rules.

## Risks / Trade-offs

- [Every new Partner account can begin replying after login without a second enable call] -> This is the requested default; documentation makes the behavior explicit and callers can pause hosting immediately with the existing endpoint.
- [The fixed job ID can later become invalid upstream] -> Preserve explicit override support and surface Funnel failures through existing reply status; do not add an unproven fallback.
- [Funnel configuration is absent] -> Fail account creation before persistence with the existing named 503 error.

## Migration Plan

1. Add focused tests for configured defaults, unavailable Funnel, and unchanged browser defaults.
2. Update Markdown and OpenAPI account-creation contracts.
3. Deploy the clean committed release to DEV after backup and server-side validation.
4. Verify the new behavior with one temporary Partner account, then delete that unscanned account.

Rollback switches the Demo service to the prior release. Accounts created by the new release keep their persisted settings and remain readable by the prior code.

## Open Questions

None.
