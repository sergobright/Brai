import assert from "node:assert/strict";
import pg from "pg";
import { quoteIdentifier } from "../src/lib/database.js";
import { readContextObservability } from "../src/lib/contextObservability.js";

const { Pool } = pg;
const baseDatabaseUrl = process.env.BRAI_TEST_DATABASE_URL;
if (!baseDatabaseUrl) throw new Error("BRAI_TEST_DATABASE_URL is required for admin context self-check");

const schemaName = `admin_context_check_${process.pid}_${Date.now()}`.replace(/\W/g, "_");
const setupPool = new Pool({ connectionString: baseDatabaseUrl, max: 1 });
const databaseUrl = withSearchPath(baseDatabaseUrl, schemaName);
const db = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await setupPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await db.query(`
    CREATE TABLE items (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      title text NOT NULL,
      deleted_at_utc text
    );
    CREATE TABLE item_role_types (
      id integer PRIMARY KEY,
      title_system text NOT NULL
    );
    CREATE TABLE item_roles (
      id integer PRIMARY KEY,
      items_id text NOT NULL,
      item_role_types_id integer NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE activities (
      id text PRIMARY KEY,
      item_roles_id integer NOT NULL,
      activity_type_id text NOT NULL
    );
    CREATE TABLE inbox (
      id text PRIMARY KEY,
      item_roles_id integer NOT NULL,
      preliminary_section text NOT NULL
    );
    CREATE TABLE events (
      id text PRIMARY KEY,
      event_domain text NOT NULL,
      event_id text NOT NULL,
      event_type text NOT NULL,
      event_action text NOT NULL,
      status text NOT NULL,
      ignore_reason text,
      subject_type text NOT NULL,
      subject_id text,
      actor_type text NOT NULL,
      actor_id text,
      occurred_at_utc text NOT NULL,
      received_at_utc text NOT NULL,
      payload_version integer NOT NULL,
      trace_id text,
      domain_sequence integer NOT NULL
    );
    CREATE TABLE agents (
      id text PRIMARY KEY,
      version text NOT NULL,
      target text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      title text NOT NULL,
      summary text NOT NULL,
      trigger_description text NOT NULL,
      conditions_description text NOT NULL,
      input_description text NOT NULL,
      output_description text NOT NULL,
      interactions_description text NOT NULL,
      side_effects_description text NOT NULL,
      llm_provider text NOT NULL,
      llm_model text NOT NULL,
      llm_timeout_ms integer,
      fallback_description text NOT NULL,
      source_module text NOT NULL,
      updated_at_utc text NOT NULL
    );
    CREATE TABLE workflow_definitions (
      id text NOT NULL,
      version integer NOT NULL,
      title text NOT NULL,
      status text NOT NULL,
      task_queue text NOT NULL,
      input_schema_version text NOT NULL,
      output_schema_version text NOT NULL,
      process_json jsonb NOT NULL,
      updated_at_utc text NOT NULL,
      PRIMARY KEY (id, version)
    );
    CREATE TABLE workflow_executions (
      id integer PRIMARY KEY,
      workflow_definition_id text NOT NULL,
      workflow_definition_version integer NOT NULL,
      workflow_id text NOT NULL,
      run_id text,
      status text NOT NULL,
      subject_kind text,
      subject_id text,
      updated_at_utc text NOT NULL
    );
    CREATE TABLE workflow_worker_heartbeats (
      id integer PRIMARY KEY,
      task_queue text NOT NULL,
      worker_identity text NOT NULL,
      build_ref text NOT NULL,
      started_at_utc text NOT NULL,
      last_seen_at_utc text NOT NULL,
      metadata_json jsonb NOT NULL
    );
    CREATE TABLE ai_logs (
      id integer PRIMARY KEY,
      agent_id text NOT NULL,
      agent_version text NOT NULL,
      dt text NOT NULL,
      status text NOT NULL,
      ai_title text NOT NULL,
      workflow_id text,
      run_id text,
      attempt_number integer,
      trace_id text
    );
    CREATE TABLE relation_types (
      id text PRIMARY KEY,
      user_id text,
      key text NOT NULL,
      title text NOT NULL,
      description text NOT NULL,
      directionality text NOT NULL,
      source_label text NOT NULL,
      target_label text NOT NULL,
      is_ordered integer NOT NULL,
      status text NOT NULL,
      is_system integer NOT NULL,
      created_by_actor_type text NOT NULL,
      created_by_actor_id text,
      updated_at_utc text NOT NULL
    );
    CREATE TABLE relation_type_endpoint_rules (
      id integer PRIMARY KEY,
      relation_types_id text NOT NULL,
      source_role_key text NOT NULL,
      source_type_key text NOT NULL,
      target_role_key text NOT NULL,
      target_type_key text NOT NULL
    );
    CREATE TABLE relations (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      relation_types_id text NOT NULL,
      source_items_id text NOT NULL,
      target_items_id text NOT NULL,
      status text NOT NULL,
      position integer,
      active_from_utc text NOT NULL,
      active_to_utc text,
      operation_id text NOT NULL,
      ended_operation_id text,
      origin_decision_id text,
      created_by_actor_type text NOT NULL,
      created_by_actor_id text,
      ended_by_actor_type text,
      ended_by_actor_id text,
      end_reason text,
      created_at_utc text NOT NULL,
      updated_at_utc text NOT NULL
    );
    CREATE TABLE context_operations (
      id text NOT NULL,
      user_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      original_operation_id text,
      result_json jsonb NOT NULL,
      compensation_json jsonb NOT NULL,
      last_error text,
      created_at_utc text NOT NULL,
      updated_at_utc text NOT NULL,
      PRIMARY KEY (user_id, id),
      FOREIGN KEY (user_id, original_operation_id) REFERENCES context_operations(user_id, id)
    );
    CREATE TABLE context_policies (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      agent_id text NOT NULL,
      agent_version text NOT NULL,
      prompt_version text NOT NULL,
      model text NOT NULL,
      schema_version text NOT NULL,
      decision_kind text NOT NULL,
      state text NOT NULL,
      active_threshold double precision,
      sample_count integer NOT NULL,
      accepted_count integer NOT NULL,
      observed_precision double precision,
      auto_accept_count_since_audit integer NOT NULL,
      activated_at_utc text,
      activation_notified_at_utc text,
      last_audit_at_utc text,
      shadow_reason text,
      created_at_utc text NOT NULL,
      updated_at_utc text NOT NULL
    );
    CREATE TABLE context_decisions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      policies_id text NOT NULL,
      agent_id text NOT NULL,
      agent_version text NOT NULL,
      prompt_version text NOT NULL,
      model text NOT NULL,
      schema_version text NOT NULL,
      decision_kind text NOT NULL,
      trigger_items_id text,
      trigger_revision integer,
      confidence double precision NOT NULL,
      rationale text NOT NULL,
      evidence_json jsonb NOT NULL,
      proposal_json jsonb NOT NULL,
      workflow_execution_id integer,
      workflow_id text,
      run_id text,
      attempt_number integer,
      evaluated_policy_state text NOT NULL,
      evaluated_threshold double precision,
      status text NOT NULL,
      resolver_actor_type text,
      resolver_actor_id text,
      resolution_action text,
      resolved_at_utc text,
      resulting_operation_id text,
      resulting_relation_id text,
      compensation_operation_id text,
      created_at_utc text NOT NULL,
      updated_at_utc text NOT NULL,
      FOREIGN KEY (user_id, resulting_operation_id) REFERENCES context_operations(user_id, id),
      FOREIGN KEY (user_id, compensation_operation_id) REFERENCES context_operations(user_id, id)
    );
    CREATE TABLE context_policy_labels (
      id integer PRIMARY KEY,
      policies_id text NOT NULL,
      decisions_id text NOT NULL,
      source text NOT NULL,
      accepted integer NOT NULL,
      confidence double precision NOT NULL,
      created_at_utc text NOT NULL
    );
    CREATE TABLE context_audit_batches (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      policies_id text NOT NULL,
      status text NOT NULL,
      window_started_at_utc text NOT NULL,
      window_ended_at_utc text NOT NULL,
      due_at_utc text NOT NULL,
      completed_at_utc text,
      created_at_utc text NOT NULL,
      updated_at_utc text NOT NULL
    );
    CREATE TABLE context_audit_items (
      id integer PRIMARY KEY,
      audit_batches_id text NOT NULL,
      decisions_id text NOT NULL,
      sample_kind text NOT NULL,
      position integer NOT NULL,
      status text NOT NULL,
      resolved_at_utc text
    );
    CREATE TABLE context_notifications (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      kind text NOT NULL,
      policies_id text NOT NULL,
      title text NOT NULL,
      read_at_utc text,
      created_at_utc text NOT NULL
    );
    CREATE TABLE context_discovery_watermarks (
      user_id text PRIMARY KEY,
      relevant_sequence bigint NOT NULL,
      processed_sequence bigint NOT NULL,
      relevant_change_count integer NOT NULL,
      last_relevant_change_at_utc text,
      active_workflow_execution_id integer,
      updated_at_utc text NOT NULL
    );
  `);
  await db.query(`
    INSERT INTO items VALUES
      ('action-1', 'user-1', 'Action', NULL),
      ('goal-1', 'user-1', 'Goal', NULL);
    INSERT INTO item_role_types VALUES (1, 'activity');
    INSERT INTO item_roles VALUES
      (1, 'action-1', 1, 'active'),
      (2, 'goal-1', 1, 'active');
    INSERT INTO activities VALUES
      ('action-1', 1, 'action'),
      ('goal-1', 2, 'goal');
    INSERT INTO agents VALUES (
      'activity.classifier', '1', 'activity', 'classifier', 'active', 'Classifier',
      'Action vs Goal', 'on change', 'eligible item', 'bounded item', 'decision',
      'Temporal only', 'none', 'openai', 'gpt-test', 1000, 'no fallback',
      'services/goal_agents/activity-classifier.js', '2026-01-01T00:00:00Z'
    );
    INSERT INTO workflow_definitions VALUES (
      'activity.classifier', 1, 'Activity classifier', 'active', 'brai-agent-activity-classifier-{environment}',
      'input.v1', 'output.v1', '{"steps":[{"agent_id":"activity.classifier"}]}',
      '2026-01-01T00:00:00Z'
    );
    INSERT INTO workflow_executions VALUES (
      1, 'activity.classifier', 1, 'workflow-1', 'run-1', 'completed', 'item',
      'action-1', '2026-01-01T00:00:00Z'
    );
    INSERT INTO workflow_worker_heartbeats VALUES (
      1, 'brai-agent-activity-classifier-preview-a', 'worker-1', 'build-1',
      now()::text, now()::text, '{}'
    );
    INSERT INTO ai_logs VALUES (
      1, 'activity.classifier', '1', '2026-01-01T00:00:00Z', 'done',
      'classified', 'workflow-1', 'run-1', 1, 'trace-1'
    );
    INSERT INTO relation_types VALUES (
      'part_of', NULL, 'part_of', 'Part of', '', 'directed', 'part', 'contains',
      1, 'active', 1, 'system', 'migration', '2026-01-01T00:00:00Z'
    );
    INSERT INTO relation_type_endpoint_rules VALUES (
      1, 'part_of', 'activity', 'action', 'activity', 'goal'
    );
    INSERT INTO relations VALUES (
      'relation-1', 'user-1', 'part_of', 'action-1', 'goal-1', 'active', 0,
      '2026-01-01T00:00:00Z', NULL, 'operation-1', NULL, 'decision-1', 'agent',
      'activity.classifier', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    ), (
      'relation-old', 'user-1', 'part_of', 'action-1', 'goal-1', 'ended', 0,
      '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z', 'operation-old',
      'operation-old-end', NULL, 'user', 'user-1', 'user', 'user-1', 'replaced',
      '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z'
    );
    INSERT INTO events VALUES (
      'relation:event-1', 'relation', 'event-1', 'create', 'relation.create',
      'accepted', NULL, 'relation', 'relation-1', 'agent', 'activity.classifier',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 'trace-1', 1
    );
    INSERT INTO context_operations VALUES
    (
      'operation-1', 'user-1', 'relation_add', 'completed', NULL,
      '{"relation_id":"relation-1"}', '{}', NULL,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    ), (
      'operation-1', 'user-2', 'relation_add', 'completed', NULL,
      '{"relation_id":"relation-2"}', '{}', NULL,
      '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
    );
    INSERT INTO context_policies VALUES
    (
      'policy-1', 'user-1', 'activity.classifier', '1', 'prompt.v1', 'gpt-test',
      'schema.v1', 'relation_add', 'shadow', NULL, 1, 1, 1, 0, NULL, NULL, NULL,
      'calibrating', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    ), (
      'policy-2', 'user-2', 'activity.classifier', '1', 'prompt.v1', 'gpt-test',
      'schema.v1', 'relation_add', 'shadow', NULL, 0, 0, NULL, 0, NULL, NULL, NULL,
      'calibrating', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
    );
    INSERT INTO context_decisions VALUES
    (
      'decision-1', 'user-1', 'policy-1', 'activity.classifier', '1', 'prompt.v1',
      'gpt-test', 'schema.v1', 'relation_add', 'action-1', 1, 0.98, 'bounded reason',
      '[{"kind":"title"}]', '{"relation_type_id":"part_of"}', 1, 'workflow-1',
      'run-1', 1, 'shadow', NULL, 'accepted', 'user', 'user-1', 'accept',
      '2026-01-01T00:00:00Z', 'operation-1', 'relation-1', NULL,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    ), (
      'decision-1-secondary', 'user-1', 'policy-1', 'activity.classifier', '1', 'prompt.v1',
      'gpt-test', 'schema.v1', 'relation_add', 'action-1', 0, 0.8, 'earlier reason',
      '[]', '{}', NULL, NULL, NULL, NULL, 'shadow', NULL, 'accepted', 'user',
      'user-1', 'accept', '2025-02-01T00:00:00Z', 'operation-1', NULL, NULL,
      '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z'
    ), (
      'decision-2', 'user-2', 'policy-2', 'activity.classifier', '1', 'prompt.v1',
      'gpt-test', 'schema.v1', 'relation_add', NULL, NULL, 0.9, 'other owner reason',
      '[]', '{}', NULL, NULL, NULL, NULL, 'shadow', NULL, 'accepted', 'user',
      'user-2', 'accept', '2025-01-01T00:00:00Z', 'operation-1', NULL, NULL,
      '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
    );
    INSERT INTO context_policy_labels VALUES (
      1, 'policy-1', 'decision-1', 'review', 1, 0.98, '2026-01-01T00:00:00Z'
    );
    INSERT INTO context_audit_batches VALUES (
      'audit-1', 'user-1', 'policy-1', 'pending', '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z', '2999-01-01T00:00:00Z', NULL,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    INSERT INTO context_audit_items VALUES (
      1, 'audit-1', 'decision-1', 'nearest_threshold', 0, 'pending', NULL
    );
    INSERT INTO context_notifications VALUES (
      'notice-1', 'user-1', 'policy_activated', 'policy-1', 'Policy active', NULL,
      '2026-01-01T00:00:00Z'
    );
    INSERT INTO context_discovery_watermarks VALUES (
      'user-1', 5, 5, 0, '2026-01-01T00:00:00Z', 1, '2026-01-01T00:00:00Z'
    );
  `);

  const summary = await readContextObservability({ databaseUrl, limit: 1 });
  assert.equal(summary.relationTypes[0].key, "part_of", "relation contract is visible");
  assert.deepEqual(summary.relations[0].diagnostics, [], "valid relation has no diagnostics");
  assert.equal(summary.relationPagination.page, 1, "relation history starts on page one");
  assert.equal(summary.relationPagination.hasNext, true, "relation history exposes a next page");
  assert.equal(summary.relationEvents[0].event_id, "event-1", "relation event ledger is visible without payload");
  assert.deepEqual(summary.decisions[0].proposal_keys, ["relation_type_id"], "decision exposes shape instead of raw proposal");
  assert.match(summary.decisions[0].evidence_excerpt, /"kind": "title"/, "bounded evidence is visible");
  assert.match(summary.decisions[0].proposal_excerpt, /"relation_type_id": "part_of"/, "bounded proposal is visible");
  assert.equal(summary.decisions[0].resulting_operation_id, "operation-1", "apply operation stays separately linkable");
  const history = await readContextObservability({ databaseUrl, limit: 1, relationPage: 2 });
  assert.equal(history.relations[0].id, "relation-old", "ended relation history is reachable");
  assert.equal(history.relationPagination.hasPrevious, true, "relation history exposes a previous page");
  assert.equal(history.relationPagination.hasNext, false, "last relation page has no next page");
  assert.equal(summary.policies[0].label_count, 1, "policy label metrics are aggregated");
  assert.equal(summary.labels[0].source, "review", "calibration label source is visible");
  assert.equal(summary.audits[0].item_count, 1, "audit items are bounded and aggregated");
  assert.equal(summary.services[0].task_queue, "brai-agent-activity-classifier-preview-a", "actual environment queue is visible");
  assert.equal(summary.services[0].definition_task_queue, "brai-agent-activity-classifier-{environment}", "definition queue template is preserved");
  assert.equal(summary.services[0].build_ref, "build-1", "exact worker build is visible");
  const invalidPage = await readContextObservability({ databaseUrl, limit: 1, relationPage: Infinity });
  assert.equal(invalidPage.relationPagination.page, 1, "non-finite relation page safely falls back");
  assert.equal(summary.agents[0].id, "activity.classifier", "specialized agent registry is visible");
  assert.equal(summary.aiLogs[0].trace_id, "trace-1", "AI attempt links are visible without output");
  assert(summary.diagnostics.every((row) => row.count === 0), "healthy fixture passes integrity diagnostics");
  const operationSummary = await readContextObservability({ databaseUrl, limit: 10 });
  assert.deepEqual(operationSummary.operations.map(({ id, user_id, decision_count }) => ({
    id, user_id, decision_count,
  })).sort((left, right) => left.user_id.localeCompare(right.user_id)), [
    { id: "operation-1", user_id: "user-1", decision_count: 2 },
    { id: "operation-1", user_id: "user-2", decision_count: 1 },
  ], "same operation id stays separately observable for each owner");
} finally {
  await db.end().catch(() => {});
  await setupPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
  await setupPool.end().catch(() => {});
}

console.log("admin context observability self-check passed");

function withSearchPath(databaseUrl, schemaName) {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options");
  url.searchParams.set("options", [existing, `-c search_path=${schemaName}`].filter(Boolean).join(" "));
  return url.toString();
}
