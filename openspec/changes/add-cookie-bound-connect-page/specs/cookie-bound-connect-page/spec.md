## ADDED Requirements

### Requirement: Focused connection page
The service SHALL expose `/connect` as a standalone page containing only WeChat Channels login/hosting status, login QR controls, and the current account's business WeChat QR controls.

#### Scenario: Focused page excludes dashboard features
- **WHEN** a visitor opens `/connect`
- **THEN** the page shows the two requested account connection panels
- **AND** it does not show session switching, model/provider selection, automation controls, private messages, comments, or reply history

### Requirement: Missing browser binding starts one QR login
The service SHALL create one transient focused-page session, start its platform QR login, and set a pending HTTP-only cookie when a browser requests focused status without a valid account-affinity or pending cookie.

#### Scenario: First focused-page visit
- **WHEN** a browser with no focused-page cookies requests focused status
- **THEN** the response returns a fresh login QR and records the pending session cookie

#### Scenario: Pending status poll
- **WHEN** the same browser polls focused status before completing the QR login
- **THEN** the service reuses the pending session and does not create another login

### Requirement: Finder identity establishes browser affinity
After QR confirmation, the service SHALL resolve the platform Finder identity to one retained Demo account and set a long-lived HTTP-only affinity cookie containing only its opaque account/session locator.

#### Scenario: Newly retained Finder account
- **WHEN** a pending focused login completes for a Finder identity not already retained
- **THEN** the next focused status response binds the browser to that authenticated account
- **AND** clears the pending cookie

#### Scenario: Finder account already retained
- **WHEN** a pending focused login completes for a Finder identity already owned by another retained session
- **THEN** the next focused status response binds the browser to the existing retained account instead of returning an account-already-connected failure
- **AND** preserves that account's history, settings, and business WeChat QR

#### Scenario: Raw Finder identifier remains server-side
- **WHEN** the service establishes focused browser affinity
- **THEN** neither focused cookie contains the raw Finder username or platform credentials

### Requirement: Later visits restore current platform state
The service SHALL use a valid focused affinity cookie to return the bound account's current platform login/hosting state and display name on later visits from the same browser.

#### Scenario: Bound browser revisits
- **WHEN** a browser with a valid affinity cookie requests focused status
- **THEN** the response returns that same retained account and its current state without creating a new login QR

#### Scenario: Bound account requires login again
- **WHEN** the bound account is retained but the platform state is `auth_required` or otherwise requires a new QR
- **THEN** the page displays that state and permits the visitor to refresh the QR on the same account

#### Scenario: Binding no longer resolves
- **WHEN** the affinity cookie references no retained account
- **THEN** the service clears it and creates one fresh pending login with a new QR

### Requirement: Business WeChat QR is account-bound
The focused page SHALL read, upload, preview, replace, and delete the business WeChat QR only for the account resolved from the focused affinity cookie.

#### Scenario: Bound account has a configured QR
- **WHEN** a bound browser loads the focused page and the account has a configured business WeChat QR
- **THEN** the page shows its preview, file metadata, replace action, and delete action

#### Scenario: Upload or replace QR
- **WHEN** a bound browser selects a valid supported image and submits it
- **THEN** the service stores it for the bound account and the page shows the updated preview

#### Scenario: Delete QR
- **WHEN** a bound browser deletes the configured business WeChat QR
- **THEN** the service removes it for that account and the page shows the unconfigured state

#### Scenario: Pending login has no current account
- **WHEN** a browser has not yet established account affinity
- **THEN** business WeChat QR mutations are unavailable and cannot target another shared account

### Requirement: Existing dashboard remains independent
The new focused-page cookies and endpoints SHALL NOT change the existing dashboard's shared-session selection behavior or its API contracts.

#### Scenario: Focused page creates or restores a binding
- **WHEN** `/connect` creates a pending login or restores an account affinity
- **THEN** it does not set, clear, or replace the dashboard owner and shared-selection cookies
