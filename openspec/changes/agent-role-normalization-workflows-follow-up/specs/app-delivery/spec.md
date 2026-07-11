## ADDED Requirements

### Requirement: Development authentication requires an explicit credential
Brai SHALL keep Preview/Dev login explicit while avoiding production OTP during
test-environment app access.

#### Scenario: Preview or Dev app opens without a session
- **WHEN** a user opens Preview/Dev web or Android without a valid session cookie
- **THEN** Brai shows one email field
- **AND** opening the page does not create a session
- **AND** any valid email logs in immediately without password or OTP
- **AND** the first login for that email creates a Better Auth user in that environment
- **AND** repeated logins for that email reuse the same user
- **AND** an empty email does not create a session

#### Scenario: Production app opens without a session
- **WHEN** a user opens production web or Android without a valid session
- **THEN** Brai keeps the normal email OTP flow
- **AND** the Preview/Dev email-only endpoint is unavailable
