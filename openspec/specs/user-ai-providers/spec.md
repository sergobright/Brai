# user-ai-providers Specification

## Purpose

This specification defines account-owned AI provider credentials, user-scoped text and
vision routing, explicit no-fallback execution, and Android account/device key separation.

## Requirements

### Requirement: Provider credentials belong to an account
Brai SHALL store at most one encrypted OpenAI, Groq, OpenRouter, or Gemini API key per
authenticated user and SHALL expose only masked metadata through ordinary APIs.

#### Scenario: User saves a provider key
- **WHEN** an authenticated user submits a valid supported-provider key
- **THEN** Brai verifies and encrypts it for that user
- **AND** another user cannot list, replace, delete, decrypt, or use it
- **AND** ordinary responses and logs contain no plaintext key

#### Scenario: Active provider key is deleted
- **WHEN** a key is bound to the user's active text or vision profile
- **THEN** deletion fails with `provider_in_use`
- **AND** the credential remains unchanged

### Requirement: AI model selection is user scoped by capability
Brai SHALL maintain an internal/external mode plus separate text and vision provider/model
profiles for each authenticated user.

#### Scenario: External mode is enabled
- **WHEN** a user enables external mode
- **THEN** both text and vision profiles reference verified account credentials and
  capability-probed models
- **AND** Inbox and Activity normalizers use the text profile
- **AND** Inbox image description uses the vision profile

#### Scenario: Profiles are configured before external mode is enabled
- **WHEN** a user in internal mode saves a verified text or vision provider/model profile
- **THEN** Brai persists the profile without changing the inference mode
- **AND** reopening settings keeps the selected provider and model editable
- **AND** external mode becomes available after both capability profiles are valid

#### Scenario: External execution fails
- **WHEN** the selected external provider rejects, limits, times out, or lacks the model
- **THEN** the agent execution fails with a safe bounded error
- **AND** Brai does not call the internal subscription model or a project provider key

### Requirement: Internal mode uses the installed subscription model
Brai SHALL use the installed Codex CLI model for the three managed agents when the owner
is in internal mode.

#### Scenario: Internal execution runs
- **WHEN** an owned workflow calls a managed AI agent in internal mode
- **THEN** it uses the configured Codex CLI model
- **AND** no user or project provider credential is required

### Requirement: Android separates anonymous and account credentials
Brai Android SHALL keep anonymous device-local provider keys separate from account-synced
keys and SHALL use account keys while authenticated.

#### Scenario: Local key is considered after login
- **WHEN** the device logs into an account that lacks that provider
- **THEN** native code revalidates and adds the local key to the account
- **AND** if the account already has the provider, its key wins without overwrite

#### Scenario: User logs out
- **WHEN** the authenticated Android user logs out or switches accounts
- **THEN** native code self-revokes the user-bound account token
- **AND** account-synced key copies are cleared or deactivated
- **AND** original anonymous device-local keys remain available for anonymous Brai CMD
