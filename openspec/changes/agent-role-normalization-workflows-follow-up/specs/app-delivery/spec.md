## ADDED Requirements

### Requirement: Development authentication requires an explicit credential
Brai SHALL keep Preview/Dev login explicit while avoiding production OTP during
test-environment web access.

#### Scenario: Preview or Dev web opens without a session
- **WHEN** a user opens Preview/Dev web without a valid session cookie
- **THEN** Brai shows one email field
- **AND** opening the page does not create a session
- **AND** the correct primary-account email logs in immediately without password or OTP
- **AND** an empty or different email does not create a session

#### Scenario: Preview or Dev Android opens without a session
- **WHEN** a user opens the native app without a valid session cookie
- **THEN** Brai shows the password form
- **AND** only the correct configured password logs into the primary account

#### Scenario: Production web opens without a session
- **WHEN** a user opens production web without a valid session
- **THEN** Brai keeps the normal email OTP flow
- **AND** the Preview/Dev email-only endpoint is unavailable
