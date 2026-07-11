## MODIFIED Requirements

### Requirement: Workflow status is visible
Brai SHALL expose actual per-step state for product workflow details.

#### Scenario: Text-only Inbox workflow completes
- **WHEN** an Inbox workflow completes without image attachments
- **THEN** `image_describer` is `skipped` with reason `not_required`
- **AND** it is not shown as an executed AI step

#### Scenario: Workflow details are read
- **WHEN** the product requests workflow details
- **THEN** every defined step has `pending`, `running`, `completed`, `failed`, or `skipped` state
- **AND** the product renders those server states without index-based inference
- **AND** unavailable state data is shown as unavailable rather than successful
