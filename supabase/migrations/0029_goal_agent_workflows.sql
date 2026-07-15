-- brai:reapply-after-production-seed
-- Acceptance reconcile migration 0029.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT '1';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT '1';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS task_queue_base text NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_service text NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS deployment_environment text;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS input_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS result_json jsonb;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS next_retry_at_utc text;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS transport_failure_count integer NOT NULL DEFAULT 0;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS contract_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS contract_hash text;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS context_capability_hash text;
DO $$ BEGIN
  ALTER TABLE workflow_executions
    ADD CONSTRAINT workflow_executions_context_capability_hash_check
    CHECK (context_capability_hash IS NULL OR context_capability_hash ~ '^[0-9a-f]{64}$');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE ai_logs ADD COLUMN IF NOT EXISTS llm_call_id text;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS definition_contract_json jsonb;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS definition_contract_hash text;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS worker_deployment_name_base text;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS worker_build_id text;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS frozen_at_utc text;
ALTER TABLE context_discovery_watermarks ADD COLUMN IF NOT EXISTS active_range_first_change_at_utc text;

UPDATE context_decisions d SET source_snapshot_hash =
  w.input_json #>> '{snapshot,material_context,content_sha256}'
FROM workflow_executions w
WHERE d.workflow_execution_id = w.id AND d.source_snapshot_hash IS NULL
  AND (w.input_json #>> '{snapshot,material_context,content_sha256}') ~ '^[0-9a-f]{64}$';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_logs_llm_call_id
  ON ai_logs (llm_call_id) WHERE llm_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_executions_goal_agents
  ON workflow_executions (user_id, workflow_definition_id, status, created_at_utc)
  WHERE workflow_definition_id IN (
    'activity.classifier', 'goal.item-matcher', 'goal.member-finder',
    'goal.discovery', 'goal.planner'
  );

INSERT INTO agents (
  id, version, target, kind, status, title, summary, trigger_description,
  conditions_description, input_description, output_description,
  interactions_description, side_effects_description, llm_provider, llm_model,
  llm_prompt_template, llm_timeout_ms, fallback_description, source_module,
  prompt_version, schema_version, task_queue_base, runtime_service, metadata_json,
  updated_at_utc
) VALUES
  (
    'activity.classifier', '1', 'activity|inbox', 'runtime', 'active',
    'Activity classifier', 'Classifies normalized Item as Action, Goal, or no_change.',
    'Create, meaningful text update, or normalization; never status/order/relation repair.',
    'Forced Operations are excluded. Exact policy begins shadow.',
    'One current Activity or normalized Inbox snapshot.',
    'At most one bounded activity_type_change decision.',
    'Separate Temporal workflow and environment queue.',
    'Produces untrusted decision only; API applies deterministically.',
    'codex', '', 'See services/brai_goal_agents/manifests/activity.classifier.json', 60000,
    'No fallback agent; workflow retries only schema-invalid output.',
    'services/brai_goal_agents/manifests/activity.classifier.json',
    'activity-classifier.v1', 'brai.activity-classifier.result.v1',
    'brai-agent-activity-classifier', 'brai-agent-activity-classifier',
    '{"review_only":false,"trigger_kinds":["create","meaningful_text","normalized"]}'::jsonb,
    now()::text
  ),
  (
    'goal.item-matcher', '1', 'activity|inbox', 'runtime', 'active',
    'Goal item matcher', 'Matches one Action/Operation to existing Goals.',
    'After classifier resolves to current Action or normalized Operation.',
    'Processes all deterministic pages of 50 and emits only part_of.',
    'One work Item plus paged current Goal catalog.',
    'Bounded relation_add decisions with existing IDs only.',
    'Separate Temporal workflow and environment queue.',
    'Produces untrusted decisions only; API applies deterministically.',
    'codex', '', 'See services/brai_goal_agents/manifests/goal.item-matcher.json', 60000,
    'No fallback agent.', 'services/brai_goal_agents/manifests/goal.item-matcher.json',
    'goal-item-matcher.v1', 'brai.goal-item-matcher.result.v1',
    'brai-agent-goal-item-matcher', 'brai-agent-goal-item-matcher',
    '{"review_only":false,"page_size":50,"relation_type":"part_of"}'::jsonb,
    now()::text
  ),
  (
    'goal.member-finder', '1', 'activity', 'runtime', 'active',
    'Goal member finder', 'Matches existing Actions/Operations to one Goal.',
    'Current Goal creation or classifier resolution.',
    'Processes all deterministic pages of 50 and emits only part_of.',
    'One Goal plus paged work Item catalog.',
    'Bounded relation_add decisions with existing IDs only.',
    'Separate Temporal workflow and environment queue.',
    'Produces untrusted decisions only; API applies deterministically.',
    'codex', '', 'See services/brai_goal_agents/manifests/goal.member-finder.json', 60000,
    'No fallback agent.', 'services/brai_goal_agents/manifests/goal.member-finder.json',
    'goal-member-finder.v1', 'brai.goal-member-finder.result.v1',
    'brai-agent-goal-member-finder', 'brai-agent-goal-member-finder',
    '{"review_only":false,"page_size":50,"relation_type":"part_of"}'::jsonb,
    now()::text
  ),
  (
    'goal.discovery', '1', 'user', 'runtime', 'active',
    'Goal discovery', 'Finds missing Goals across current work.',
    'After five relevant changes or 24 hours with at least one change.',
    'One active run per user; page-map and bounded merge; always review-only.',
    'All current Actions/Operations in deterministic pages of 50 plus current Goals.',
    'Editable Goal draft with at least two existing members.',
    'Separate Temporal workflow and environment queue.',
    'Produces review-only draft; API never auto-applies it.',
    'codex', '', 'See services/brai_goal_agents/manifests/goal.discovery.json', 90000,
    'No fallback agent.', 'services/brai_goal_agents/manifests/goal.discovery.json',
    'goal-discovery.v1', 'brai.goal-discovery.result.v1',
    'brai-agent-goal-discovery', 'brai-agent-goal-discovery',
    '{"review_only":true,"page_size":50,"pipeline":["map","merge"]}'::jsonb,
    now()::text
  ),
  (
    'goal.planner', '1', 'activity', 'runtime', 'active',
    'Goal planner', 'Creates an editable plan of 2..20 Action drafts for one Goal.',
    'Explicit authenticated user request only.',
    'Current Goal snapshot; always review-only.',
    'Goal and current ordered memberships.',
    'Editable ordered package of 2..20 Action drafts.',
    'Separate Temporal workflow and environment queue.',
    'Produces review-only draft; API never auto-applies it.',
    'codex', '', 'See services/brai_goal_agents/manifests/goal.planner.json', 90000,
    'No fallback agent.', 'services/brai_goal_agents/manifests/goal.planner.json',
    'goal-planner.v1', 'brai.goal-planner.result.v1',
    'brai-agent-goal-planner', 'brai-agent-goal-planner',
    '{"review_only":true,"explicit_trigger_only":true,"minimum_steps":2,"maximum_steps":20}'::jsonb,
    now()::text
  )
ON CONFLICT (id) DO UPDATE SET
  version = excluded.version,
  target = excluded.target,
  kind = excluded.kind,
  status = excluded.status,
  title = excluded.title,
  summary = excluded.summary,
  trigger_description = excluded.trigger_description,
  conditions_description = excluded.conditions_description,
  input_description = excluded.input_description,
  output_description = excluded.output_description,
  interactions_description = excluded.interactions_description,
  side_effects_description = excluded.side_effects_description,
  llm_provider = excluded.llm_provider,
  llm_model = excluded.llm_model,
  llm_prompt_template = excluded.llm_prompt_template,
  llm_timeout_ms = excluded.llm_timeout_ms,
  fallback_description = excluded.fallback_description,
  source_module = excluded.source_module,
  prompt_version = excluded.prompt_version,
  schema_version = excluded.schema_version,
  task_queue_base = excluded.task_queue_base,
  runtime_service = excluded.runtime_service,
  metadata_json = excluded.metadata_json,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO workflow_definitions (
  id, version, title, description, status, task_queue, steps_json,
  diagram_mermaid, input_schema_version, input_schema_json,
  output_schema_version, output_schema_json, process_json,
  created_at_utc, updated_at_utc
)
SELECT
  a.id,
  1,
  a.title,
  a.summary,
  'active',
  a.task_queue_base || '-{environment}',
  CASE a.id
    WHEN 'goal.discovery' THEN '["dispatch","map_pages","merge","persist_decisions"]'
    WHEN 'goal.item-matcher' THEN '["dispatch","match_pages","persist_decisions"]'
    WHEN 'goal.member-finder' THEN '["dispatch","match_pages","persist_decisions"]'
    ELSE '["dispatch","invoke_agent","persist_decisions"]'
  END,
  CASE a.id
    WHEN 'activity.classifier' THEN $diagram$flowchart LR
      queued["Durable classifier execution"] --> classify["Classify Action or Inbox Item"]
      classify --> decision["Type/no-change decision"]
      decision --> route["Resolve policy, then route current type"]$diagram$
    WHEN 'goal.item-matcher' THEN $diagram$flowchart LR
      queued["Durable item matcher execution"] --> pages["Traverse every Goal page <= 50"]
      pages --> dedupe["Deduplicate part_of proposals"]
      dedupe --> decisions["Persist independent membership decisions"]$diagram$
    WHEN 'goal.member-finder' THEN $diagram$flowchart LR
      queued["Durable member finder execution"] --> pages["Traverse every work-item page <= 50"]
      pages --> dedupe["Deduplicate existing members"]
      dedupe --> decisions["Persist independent part_of decisions"]$diagram$
    WHEN 'goal.discovery' THEN $diagram$flowchart LR
      queued["Durable watermark execution"] --> map["Map every work-item page <= 50"]
      map --> merge["Bounded deterministic merge tree"]
      merge --> draft["Persist editable Goal drafts"]$diagram$
    ELSE $diagram$flowchart LR
      queued["Explicit Goal plan request"] --> plan["Generate 2..20 Action drafts"]
      plan --> review["Persist editable review-only plan"]
      review --> apply["Atomic accept creates Actions and memberships"]$diagram$
  END,
  'brai.goal-agent.input.v1',
  '{"type":"object","required":["schema_version","agent_id","user_id","trigger","snapshot","catalogs"],"additionalProperties":true}',
  a.schema_version,
  '{"type":"object","required":["status","decisions","llm_calls"],"additionalProperties":true}',
  jsonb_build_object(
    'agent_id', a.id,
    'service', a.runtime_service,
    'queue_base', a.task_queue_base,
    'source_manifest', a.source_module,
    'review_only', COALESCE((a.metadata_json->>'review_only')::boolean, false),
    'stages', CASE a.id
      WHEN 'activity.classifier' THEN jsonb_build_array('dispatch', 'classify', 'persist_decision', 'route')
      WHEN 'goal.item-matcher' THEN jsonb_build_array('dispatch', 'goal_pages', 'dedupe', 'persist_decisions')
      WHEN 'goal.member-finder' THEN jsonb_build_array('dispatch', 'work_item_pages', 'dedupe', 'persist_decisions')
      WHEN 'goal.discovery' THEN jsonb_build_array('dispatch', 'map_pages', 'merge_tree', 'persist_drafts')
      ELSE jsonb_build_array('dispatch', 'plan', 'persist_editable_draft')
    END
  ),
  now()::text,
  now()::text
FROM agents a
WHERE a.id IN (
  'activity.classifier', 'goal.item-matcher', 'goal.member-finder',
  'goal.discovery', 'goal.planner'
)
ON CONFLICT (id, version) DO NOTHING;

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  ('agents', 'Agents', 'Versioned runtime AI agent registry.', 'Goal agents add exact prompt/schema versions, task queue base, service family and bounded manifest metadata. Full source contracts live in services/brai_goal_agents/manifests.', now()::text),
  ('workflow_executions', 'Workflow executions', 'Durable generic product workflow requests and results.', 'Goal-agent executions persist environment-qualified workflow identity, typed subject/trigger, bounded input/result, dispatch and terminal state before Temporal transport.', now()::text),
  ('ai_logs', 'AI logs', 'One row per observable completed/provider-failed LLM invocation.', 'llm_call_id uniquely deduplicates durable result delivery. Unknown provider crash windows remain workflow attempts without fabricated AI rows.', now()::text)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (65, now()::text, 'register five Goal agents and durable environment-qualified workflows')
ON CONFLICT (version) DO NOTHING;
