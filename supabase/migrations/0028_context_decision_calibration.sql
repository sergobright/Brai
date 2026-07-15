-- brai:reapply-after-production-seed
-- Acceptance reconcile migration 0028.

ALTER TABLE workflow_executions ALTER COLUMN role_contract_id DROP NOT NULL;
ALTER TABLE workflow_executions ALTER COLUMN raw_record_id DROP NOT NULL;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS subject_kind text;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS trigger_kind text;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS trigger_revision integer;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS watermark_from bigint;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS watermark_to bigint;

ALTER TABLE workflow_executions
  DROP CONSTRAINT IF EXISTS workflow_executions_subject_contract_check;
ALTER TABLE workflow_executions
  ADD CONSTRAINT workflow_executions_subject_contract_check CHECK (
    (role_contract_id IS NOT NULL AND raw_record_id IS NOT NULL)
    OR COALESCE(subject_kind IN ('item', 'goal', 'user') AND length(btrim(subject_id)) > 0, false)
  );

CREATE INDEX IF NOT EXISTS idx_workflow_executions_subject
  ON workflow_executions (user_id, subject_kind, subject_id, created_at_utc DESC)
  WHERE subject_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_executions_watermark
  ON workflow_executions (user_id, workflow_definition_id, watermark_from, watermark_to)
  WHERE watermark_from IS NOT NULL;

INSERT INTO sequence_counters (name, last_value)
VALUES ('context.decision_revision', 0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS context_operations (
  id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'relation_add', 'relation_end', 'relation_reorder', 'activity_type_change',
    'inbox_conversion', 'goal_discovery', 'goal_plan', 'compensation'
  )),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'compensated')),
  original_operation_id text,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  compensation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  CONSTRAINT context_operations_pkey PRIMARY KEY (user_id, id),
  CONSTRAINT context_operations_original_owner_operation_fkey
    FOREIGN KEY (user_id, original_operation_id) REFERENCES context_operations(user_id, id)
);

CREATE TABLE IF NOT EXISTS context_policies (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents(id),
  agent_version text NOT NULL,
  prompt_version text NOT NULL,
  model text NOT NULL,
  schema_version text NOT NULL,
  decision_kind text NOT NULL CHECK (decision_kind IN (
    'activity_type_change', 'relation_add', 'goal_discovery', 'goal_plan',
    'relation_type_candidate'
  )),
  state text NOT NULL DEFAULT 'shadow' CHECK (state IN ('shadow', 'active')),
  active_threshold double precision CHECK (
    active_threshold IS NULL OR active_threshold BETWEEN 0 AND 1
  ),
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  observed_precision double precision CHECK (
    observed_precision IS NULL OR observed_precision BETWEEN 0 AND 1
  ),
  auto_accept_count_since_audit integer NOT NULL DEFAULT 0 CHECK (auto_accept_count_since_audit >= 0),
  activated_at_utc text,
  activation_notified_at_utc text,
  last_audit_at_utc text,
  shadow_reason text CHECK (shadow_reason IS NULL OR length(shadow_reason) <= 500),
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  UNIQUE (user_id, agent_id, agent_version, prompt_version, model, schema_version, decision_kind),
  CHECK (
    (state = 'active' AND active_threshold IS NOT NULL)
    OR (state = 'shadow' AND active_threshold IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS context_decisions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  policies_id text NOT NULL REFERENCES context_policies(id),
  agent_id text NOT NULL REFERENCES agents(id),
  agent_version text NOT NULL,
  prompt_version text NOT NULL,
  model text NOT NULL,
  schema_version text NOT NULL,
  decision_kind text NOT NULL CHECK (decision_kind IN (
    'activity_type_change', 'relation_add', 'goal_discovery', 'goal_plan',
    'relation_type_candidate'
  )),
  trigger_items_id text REFERENCES items(id),
  trigger_revision integer CHECK (trigger_revision IS NULL OR trigger_revision >= 0),
  source_snapshot_hash text CHECK (
    source_snapshot_hash IS NULL OR source_snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  proposal_hash text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale text NOT NULL DEFAULT '' CHECK (length(rationale) <= 2000),
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(evidence_json) = 'array' AND octet_length(evidence_json::text) <= 16000
  ),
  proposal_json jsonb NOT NULL CHECK (
    jsonb_typeof(proposal_json) = 'object' AND octet_length(proposal_json::text) <= 64000
  ),
  workflow_execution_id integer REFERENCES workflow_executions(id),
  workflow_id text,
  run_id text,
  attempt_number integer CHECK (attempt_number IS NULL OR attempt_number > 0),
  evaluated_policy_state text NOT NULL CHECK (evaluated_policy_state IN ('shadow', 'active')),
  evaluated_threshold double precision CHECK (
    evaluated_threshold IS NULL OR evaluated_threshold BETWEEN 0 AND 1
  ),
  status text NOT NULL CHECK (status IN (
    'pending', 'accepted', 'rejected', 'auto_accepted', 'undone',
    'audit_confirmed', 'audit_rejected', 'stale_context'
  )),
  resolver_actor_type text CHECK (resolver_actor_type IS NULL OR resolver_actor_type IN ('user', 'system')),
  resolver_actor_id text,
  resolution_key text,
  resolution_action text CHECK (resolution_action IS NULL OR resolution_action IN ('accept', 'reject', 'undo')),
  resolution_payload_hash text,
  resolved_at_utc text,
  resulting_operation_id text,
  resulting_relation_id text REFERENCES relations(id),
  compensation_operation_id text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  UNIQUE (user_id, policies_id, trigger_items_id, trigger_revision, proposal_hash),
  UNIQUE (user_id, resolution_key),
  CONSTRAINT context_decisions_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT context_decisions_resulting_owner_operation_fkey
    FOREIGN KEY (user_id, resulting_operation_id) REFERENCES context_operations(user_id, id),
  CONSTRAINT context_decisions_compensation_owner_operation_fkey
    FOREIGN KEY (user_id, compensation_operation_id) REFERENCES context_operations(user_id, id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'context_decisions_user_id_id_key'
      AND conrelid = 'context_decisions'::regclass
  ) THEN
    ALTER TABLE context_decisions ADD CONSTRAINT context_decisions_user_id_id_key
      UNIQUE (user_id, id);
  END IF;
END;
$$;

-- Earlier reapplications created a global operation primary key. Remove its
-- single-column dependants before replacing it with the canonical owner key.
ALTER TABLE context_decisions
  DROP CONSTRAINT IF EXISTS context_decisions_resulting_operation_id_fkey;
ALTER TABLE context_decisions
  DROP CONSTRAINT IF EXISTS context_decisions_compensation_operation_id_fkey;
ALTER TABLE context_operations
  DROP CONSTRAINT IF EXISTS context_operations_original_operation_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'context_operations'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, id)'
  ) THEN
    ALTER TABLE context_operations DROP CONSTRAINT IF EXISTS context_operations_pkey;
    ALTER TABLE context_operations
      ADD CONSTRAINT context_operations_pkey PRIMARY KEY (user_id, id);
  END IF;
END;
$$;

ALTER TABLE context_operations
  DROP CONSTRAINT IF EXISTS context_operations_user_id_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'context_operations_original_owner_operation_fkey'
      AND conrelid = 'context_operations'::regclass
  ) THEN
    ALTER TABLE context_operations
      ADD CONSTRAINT context_operations_original_owner_operation_fkey
      FOREIGN KEY (user_id, original_operation_id)
      REFERENCES context_operations(user_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'context_decisions_resulting_owner_operation_fkey'
      AND conrelid = 'context_decisions'::regclass
  ) THEN
    ALTER TABLE context_decisions
      ADD CONSTRAINT context_decisions_resulting_owner_operation_fkey
      FOREIGN KEY (user_id, resulting_operation_id)
      REFERENCES context_operations(user_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'context_decisions_compensation_owner_operation_fkey'
      AND conrelid = 'context_decisions'::regclass
  ) THEN
    ALTER TABLE context_decisions
      ADD CONSTRAINT context_decisions_compensation_owner_operation_fkey
      FOREIGN KEY (user_id, compensation_operation_id)
      REFERENCES context_operations(user_id, id);
  END IF;
END;
$$;

ALTER TABLE context_decisions ADD COLUMN IF NOT EXISTS source_snapshot_hash text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'context_decisions_source_snapshot_hash_check'
      AND conrelid = 'context_decisions'::regclass
  ) THEN
    ALTER TABLE context_decisions ADD CONSTRAINT context_decisions_source_snapshot_hash_check
      CHECK (source_snapshot_hash IS NULL OR source_snapshot_hash ~ '^[0-9a-f]{64}$');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS context_policy_labels (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  policies_id text NOT NULL REFERENCES context_policies(id),
  decisions_id text NOT NULL REFERENCES context_decisions(id),
  source text NOT NULL CHECK (source IN ('review', 'audit', 'undo')),
  accepted integer NOT NULL CHECK (accepted IN (0, 1)),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at_utc text NOT NULL,
  UNIQUE (decisions_id, source)
);

CREATE TABLE IF NOT EXISTS context_audit_batches (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  policies_id text NOT NULL REFERENCES context_policies(id),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'overdue')),
  window_started_at_utc text NOT NULL,
  window_ended_at_utc text NOT NULL,
  due_at_utc text NOT NULL,
  completed_at_utc text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  UNIQUE (policies_id, window_started_at_utc, window_ended_at_utc)
);

CREATE TABLE IF NOT EXISTS context_audit_items (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  audit_batches_id text NOT NULL REFERENCES context_audit_batches(id),
  decisions_id text NOT NULL REFERENCES context_decisions(id),
  sample_kind text NOT NULL CHECK (sample_kind IN ('nearest_threshold', 'random')),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  resolution_key text,
  resolution_action text CHECK (resolution_action IS NULL OR resolution_action IN ('confirm', 'reject')),
  resolved_at_utc text,
  created_at_utc text NOT NULL,
  UNIQUE (audit_batches_id, position),
  UNIQUE (decisions_id)
);

ALTER TABLE context_audit_items ADD COLUMN IF NOT EXISTS resolution_key text;
ALTER TABLE context_audit_items ADD COLUMN IF NOT EXISTS resolution_action text;
ALTER TABLE context_audit_items DROP CONSTRAINT IF EXISTS context_audit_items_resolution_action_check;
ALTER TABLE context_audit_items ADD CONSTRAINT context_audit_items_resolution_action_check
  CHECK (resolution_action IS NULL OR resolution_action IN ('confirm', 'reject'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_audit_items_resolution_key
  ON context_audit_items (audit_batches_id, resolution_key)
  WHERE resolution_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS context_notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('policy_activated')),
  policies_id text NOT NULL REFERENCES context_policies(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  read_at_utc text,
  created_at_utc text NOT NULL,
  UNIQUE (user_id, kind, policies_id)
);

CREATE TABLE IF NOT EXISTS context_discovery_watermarks (
  user_id text PRIMARY KEY,
  relevant_sequence bigint NOT NULL DEFAULT 0 CHECK (relevant_sequence >= 0),
  processed_sequence bigint NOT NULL DEFAULT 0 CHECK (processed_sequence >= 0),
  relevant_change_count integer NOT NULL DEFAULT 0 CHECK (relevant_change_count >= 0),
  first_unprocessed_change_at_utc text,
  last_relevant_change_at_utc text,
  active_workflow_execution_id integer REFERENCES workflow_executions(id),
  updated_at_utc text NOT NULL,
  CHECK (processed_sequence <= relevant_sequence)
);

ALTER TABLE context_discovery_watermarks
  ADD COLUMN IF NOT EXISTS first_unprocessed_change_at_utc text;

CREATE INDEX IF NOT EXISTS idx_context_decisions_pending
  ON context_decisions (user_id, status, created_at_utc DESC, id);
CREATE INDEX IF NOT EXISTS idx_context_decisions_status_page
  ON context_decisions (user_id, status, created_at_utc DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_context_decisions_policy_confidence
  ON context_decisions (policies_id, confidence, created_at_utc, id);
CREATE INDEX IF NOT EXISTS idx_context_decisions_rejected_discovery_source
  ON context_decisions (user_id, source_snapshot_hash, proposal_hash)
  WHERE decision_kind = 'goal_discovery' AND status = 'rejected'
    AND source_snapshot_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_policy_labels_policy
  ON context_policy_labels (policies_id, confidence, accepted, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_context_audit_batches_due
  ON context_audit_batches (user_id, status, due_at_utc);
CREATE INDEX IF NOT EXISTS idx_context_audit_batches_status_page
  ON context_audit_batches (user_id, status, created_at_utc DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_context_audit_batches_reconcile
  ON context_audit_batches (status, due_at_utc);
CREATE INDEX IF NOT EXISTS idx_context_notifications_unread
  ON context_notifications (user_id, created_at_utc) WHERE read_at_utc IS NULL;
CREATE INDEX IF NOT EXISTS idx_context_operations_user_status
  ON context_operations (user_id, status, updated_at_utc DESC);

ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_origin_decision_id_fkey;
-- Legacy global provenance could point at another owner's otherwise valid decision.
UPDATE relations AS relation SET origin_decision_id = NULL
WHERE relation.origin_decision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM context_decisions AS decision
    WHERE decision.user_id = relation.user_id AND decision.id = relation.origin_decision_id
  );
ALTER TABLE relations ADD CONSTRAINT relations_origin_decision_id_fkey
  FOREIGN KEY (user_id, origin_decision_id)
  REFERENCES context_decisions(user_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE context_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_policy_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_audit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_audit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_discovery_watermarks ENABLE ROW LEVEL SECURITY;

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  ('context_operations', 'Context operations', 'Idempotent mutation and compensation registry.', 'Stores canonical request hash, outcome and bounded compensation metadata for Relations, type changes, Inbox conversion, Goal drafts and undo.', now()::text),
  ('context_policies', 'Context policies', 'Exact-version calibration state for one user and decision kind.', 'Every agent/prompt/model/schema key starts shadow. Only eligible simple decisions can activate at >=25 labels and >=95% precision; discovery/planner remain review-only.', now()::text),
  ('context_decisions', 'Context decisions', 'Durable versioned untrusted AI proposals and resolution provenance.', 'Stores bounded proposal/evidence, canonical source snapshot and proposal hashes, exact execution contract, policy snapshot, lifecycle and resulting/compensating operation links. Rejected discovery drafts are suppressed only for the same user, source snapshot and proposal hash.', now()::text),
  ('context_policy_labels', 'Context policy labels', 'Review, audit and undo quality labels.', 'Manual domain mutations do not create labels. Rows are immutable evidence for threshold and precision evaluation.', now()::text),
  ('context_audit_batches', 'Context audit batches', 'Five-item periodic audits for active policies.', 'Batches are created after 100 auto-accepts or 30 days, are due after 14 days and return overdue policies to shadow.', now()::text),
  ('context_audit_items', 'Context audit items', 'Three nearest-threshold and two random decisions in one audit.', 'Each decision is audited at most once; confirmation/rejection updates calibration and rejection triggers compensation.', now()::text),
  ('context_notifications', 'Context notifications', 'One-time informational policy activation notices.', 'Notifications are non-modal and never request cascade approval. Unique policy activation prevents repeated notices.', now()::text),
  ('context_discovery_watermarks', 'Context discovery watermarks', 'Durable per-user relevant-change and processed ranges.', 'Supports five-change/24-hour discovery triggers, restart recovery and at most one active discovery run per user.', now()::text),
  ('workflow_executions', 'Workflow executions', 'Compact generic read model for product workflows.', 'Keeps legacy role/raw references and adds typed Item/Goal/user subject, trigger revision and discovery watermark fields without overloading raw_record_id.', now()::text),
  ('workflow_worker_heartbeats', 'Workflow worker heartbeats', 'Observed worker poller health by exact environment queue.', 'Goal-agent rows are written by the environment API after Temporal task-queue observation; stateless workers do not receive DB credentials.', now()::text)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (64, now()::text, 'add context decisions, calibration, audits, operations, and generic workflow subjects')
ON CONFLICT (version) DO NOTHING;
