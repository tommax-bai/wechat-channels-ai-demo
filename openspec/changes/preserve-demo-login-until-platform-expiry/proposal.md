## Why

The Demo currently deletes otherwise usable WeChat Channels login authority after an operator-configured eight-hour deadline. That deadline is not supplied or guaranteed by WeChat, so it needlessly interrupts demonstrations and forces customers to scan again while the platform session may still be valid.

## What Changes

- Remove the Demo-owned absolute expiry from authenticated platform sessions.
- Keep authenticated sessions and their background workers active across page closure and service restart until WeChat explicitly reports that authentication is no longer valid, or a user logs out.
- Convert an explicit platform authentication failure into a visible re-login state and prompt for a fresh QR code.
- Keep QR-code expiry bounded and retain cleanup for abandoned, unauthenticated login attempts.
- Stop displaying a fabricated authenticated-session expiry in the page and shared-session switcher.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `multi-user-qr-auth`: Replace the configured absolute lifetime of an authenticated Demo session with a platform-authoritative login lifetime while retaining bounded QR and unauthenticated-session cleanup.

## Impact

- Session repository queries, cleanup, capacity accounting, worker admission, and send guards.
- Session API projections and public account-switching copy.
- Environment configuration and deployment documentation.
- Existing SQLite rows must remain readable; no destructive migration or credential reset is required.
