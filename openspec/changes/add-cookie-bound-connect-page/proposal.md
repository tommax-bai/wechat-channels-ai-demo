## Why

The Demo needs a focused account-connection page that a customer can revisit without seeing the interaction dashboard or manually selecting a retained shared session. The browser must return to the Finder account it scanned, while a browser with no valid account binding must receive a fresh login QR.

## What Changes

- Add a standalone `/connect` page containing WeChat Channels login status/QR controls, recruitment reply settings, and the current account's business WeChat QR upload, preview, replace, and delete controls.
- Add an HTTP-only browser affinity cookie that is issued only after a scanned Finder identity resolves to a retained Demo account.
- Restore the bound account and its current platform login/hosting state on later visits from the same browser.
- Automatically create a transient login session and request a fresh platform QR when the affinity cookie is missing or no longer resolves.
- When a newly scanned Finder identity is already retained by the Demo, bind the browser to that existing account instead of presenting `account_already_connected` on the focused page.
- Initialize new focused-page login sessions with the recruitment API and job ID `4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb`, and let a bound account explicitly save a job ID from the focused page.
- Keep the existing dashboard, shared-session switcher, reply settings, content lists, and worker behavior unchanged.

## Capabilities

### New Capabilities

- `cookie-bound-connect-page`: Focused login/contact-QR UI and server-owned browser-to-Finder-account affinity lifecycle.

### Modified Capabilities

None.

## Impact

- Adds a new static page and browser script under `public/` plus focused endpoints and cookie resolution in `src/server.ts`.
- Extends the persisted session record just enough to hand a duplicate-account login attempt back to the already retained account.
- Adds migration, integration, UI-copy, and focused page tests.
- Does not change the public partner API, sync/reply workers, existing `/` dashboard contract, or DEV service topology.
