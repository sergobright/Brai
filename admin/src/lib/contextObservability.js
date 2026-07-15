import { openReadOnlyDatabase, resolveDatabaseUrl } from "./database.js";

const DEFAULT_LIMIT = 50;
const MAX_RELATION_PAGE = 100_000;
const GOAL_AGENT_IDS = [
  "activity.classifier",
  "goal.item-matcher",
  "goal.member-finder",
  "goal.discovery",
  "goal.planner",
];

export async function readContextObservability({
  databaseUrl = resolveDatabaseUrl(),
  limit = DEFAULT_LIMIT,
  relationPage = 1,
} = {}) {
  const requestedLimit = Number(limit);
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : DEFAULT_LIMIT;
  const requestedPage = Number(relationPage);
  const safeRelationPage = Number.isFinite(requestedPage)
    ? Math.min(Math.max(Math.floor(requestedPage), 1), MAX_RELATION_PAGE) : 1;
  const relationOffset = (safeRelationPage - 1) * safeLimit;
  const db = openReadOnlyDatabase(databaseUrl);
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    const relationTypes = await client.query(`
      SELECT t.id, t.user_id, t.key, t.title, t.description, t.directionality,
        t.source_label, t.target_label, t.is_ordered, t.status, t.is_system,
        t.created_by_actor_type, t.created_by_actor_id, t.updated_at_utc,
        COUNT(DISTINCT r.id)::int AS relation_count,
        COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'active')::int AS active_count,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
          'source_role_key', rule.source_role_key,
          'source_type_key', rule.source_type_key,
          'target_role_key', rule.target_role_key,
          'target_type_key', rule.target_type_key
        )) FILTER (WHERE rule.id IS NOT NULL), '[]'::jsonb) AS rules
      FROM relation_types t
      LEFT JOIN relation_type_endpoint_rules rule ON rule.relation_types_id = t.id
      LEFT JOIN relations r ON r.relation_types_id = t.id
      GROUP BY t.id
      ORDER BY CASE t.status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
        t.is_system DESC, t.key
      LIMIT $1
    `, [safeLimit]);
    const relationResult = await client.query(`
      WITH item_types AS (
        SELECT roles.items_id, role_types.title_system AS role_key,
          activities.activity_type_id AS type_key
        FROM item_roles roles
        JOIN item_role_types role_types ON role_types.id = roles.item_role_types_id
        JOIN activities ON activities.item_roles_id = roles.id
        WHERE roles.status = 'active' AND role_types.title_system = 'activity'
        UNION ALL
        SELECT roles.items_id, role_types.title_system AS role_key,
          inbox.preliminary_section AS type_key
        FROM item_roles roles
        JOIN item_role_types role_types ON role_types.id = roles.item_role_types_id
        JOIN inbox ON inbox.item_roles_id = roles.id
        WHERE roles.status = 'active' AND role_types.title_system = 'inbox'
      ), ranked AS (
        SELECT r.*,
          row_number() OVER (
            PARTITION BY r.user_id, r.relation_types_id, r.target_items_id, r.status
            ORDER BY r.position NULLS LAST, r.id
          ) - 1 AS expected_position
        FROM relations r
      )
      SELECT r.id, r.user_id, r.relation_types_id, t.key AS relation_type_key,
        t.directionality, r.source_items_id, source.title AS source_title,
        r.target_items_id, target.title AS target_title, r.status, r.position,
        r.active_from_utc, r.active_to_utc, r.operation_id, r.ended_operation_id,
        r.origin_decision_id, r.created_by_actor_type, r.created_by_actor_id,
        r.ended_by_actor_type, r.ended_by_actor_id, r.end_reason, r.created_at_utc, r.updated_at_utc,
        array_remove(ARRAY[
          CASE WHEN source.id IS NULL THEN 'missing_source' END,
          CASE WHEN target.id IS NULL THEN 'missing_target' END,
          CASE WHEN source.deleted_at_utc IS NOT NULL THEN 'deleted_source' END,
          CASE WHEN target.deleted_at_utc IS NOT NULL THEN 'deleted_target' END,
          CASE WHEN source.user_id IS DISTINCT FROM r.user_id THEN 'source_owner_mismatch' END,
          CASE WHEN target.user_id IS DISTINCT FROM r.user_id THEN 'target_owner_mismatch' END,
          CASE WHEN t.status <> 'active' AND r.status = 'active' THEN 'inactive_relation_type' END,
          CASE WHEN t.is_ordered = 1 AND r.status = 'active'
            AND r.position IS DISTINCT FROM r.expected_position::int THEN 'non_dense_position' END,
          CASE WHEN t.is_ordered = 0 AND r.position IS NOT NULL THEN 'unexpected_position' END,
          CASE WHEN r.status = 'active' AND NOT EXISTS (
            SELECT 1
            FROM relation_type_endpoint_rules rule
            JOIN item_types source_type ON source_type.items_id = r.source_items_id
              AND source_type.role_key = rule.source_role_key
              AND source_type.type_key = rule.source_type_key
            JOIN item_types target_type ON target_type.items_id = r.target_items_id
              AND target_type.role_key = rule.target_role_key
              AND target_type.type_key = rule.target_type_key
            WHERE rule.relation_types_id = r.relation_types_id
          ) THEN 'endpoint_rule_mismatch' END
        ], NULL) AS diagnostics
      FROM ranked r
      JOIN relation_types t ON t.id = r.relation_types_id
      LEFT JOIN items source ON source.id = r.source_items_id
      LEFT JOIN items target ON target.id = r.target_items_id
      ORDER BY r.updated_at_utc DESC, r.id DESC
      LIMIT $1 OFFSET $2
    `, [safeLimit + 1, relationOffset]);
    const relations = relationResult.rows.slice(0, safeLimit);
    const decisions = await client.query(`
      SELECT d.id, d.user_id, d.policies_id, d.agent_id, d.agent_version, d.prompt_version,
        d.model, d.schema_version, d.decision_kind, d.trigger_items_id,
        d.trigger_revision, d.confidence,
        left(d.rationale, 500) AS rationale_excerpt,
        length(d.rationale) > 500 AS rationale_truncated,
        jsonb_array_length(d.evidence_json) AS evidence_count,
        left(d.evidence_json::text, 4000) AS evidence_excerpt,
        length(d.evidence_json::text) > 4000 AS evidence_truncated,
        COALESCE((SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(d.proposal_json) AS key), ARRAY[]::text[]) AS proposal_keys,
        left(d.proposal_json::text, 4000) AS proposal_excerpt,
        length(d.proposal_json::text) > 4000 AS proposal_truncated,
        d.workflow_execution_id, d.workflow_id, d.run_id, d.attempt_number,
        d.evaluated_policy_state, d.evaluated_threshold, d.status,
        d.resolver_actor_type, d.resolver_actor_id, d.resolution_action, d.resolved_at_utc,
        d.resulting_operation_id, d.resulting_relation_id,
        d.compensation_operation_id, d.created_at_utc, d.updated_at_utc,
        p.state AS current_policy_state, p.active_threshold AS current_policy_threshold
      FROM context_decisions d
      JOIN context_policies p ON p.id = d.policies_id
      ORDER BY d.created_at_utc DESC, d.id DESC
      LIMIT $1
    `, [safeLimit]);
    const policies = await client.query(`
      SELECT p.id, p.user_id, p.agent_id, p.agent_version, p.prompt_version,
        p.model, p.schema_version, p.decision_kind, p.state, p.active_threshold,
        p.sample_count, p.accepted_count, p.observed_precision,
        p.auto_accept_count_since_audit, p.activated_at_utc,
        p.activation_notified_at_utc, p.last_audit_at_utc, p.shadow_reason,
        p.created_at_utc, p.updated_at_utc,
        COUNT(DISTINCT l.id)::int AS label_count,
        COUNT(DISTINCT l.id) FILTER (WHERE l.accepted = 1)::int AS positive_label_count,
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'pending')::int AS pending_audits,
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'overdue' OR
          (b.status = 'pending' AND b.due_at_utc::timestamptz < now()))::int AS overdue_audits
      FROM context_policies p
      LEFT JOIN context_policy_labels l ON l.policies_id = p.id
      LEFT JOIN context_audit_batches b ON b.policies_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at_utc DESC, p.id
      LIMIT $1
    `, [safeLimit]);
    const audits = await client.query(`
      SELECT b.id, b.user_id, b.policies_id, b.status, b.window_started_at_utc,
        b.window_ended_at_utc, b.due_at_utc, b.completed_at_utc,
        b.created_at_utc, b.updated_at_utc,
        COUNT(i.id)::int AS item_count,
        COUNT(i.id) FILTER (WHERE i.status = 'pending')::int AS pending_count,
        COUNT(i.id) FILTER (WHERE i.status = 'confirmed')::int AS confirmed_count,
        COUNT(i.id) FILTER (WHERE i.status = 'rejected')::int AS rejected_count,
        COALESCE(jsonb_agg(jsonb_build_object(
          'position', i.position, 'decision_id', i.decisions_id,
          'sample_kind', i.sample_kind, 'status', i.status,
          'resolved_at_utc', i.resolved_at_utc
        ) ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
      FROM context_audit_batches b
      LEFT JOIN context_audit_items i ON i.audit_batches_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at_utc DESC, b.id DESC
      LIMIT $1
    `, [safeLimit]);
    const operations = await client.query(`
      SELECT o.id, o.user_id, o.kind, o.status, o.original_operation_id,
        COALESCE((SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(o.result_json) AS key), ARRAY[]::text[]) AS result_keys,
        COALESCE((SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(o.compensation_json) AS key), ARRAY[]::text[]) AS compensation_keys,
        o.last_error, o.created_at_utc, o.updated_at_utc,
        COUNT(DISTINCT d.id)::int AS decision_count
      FROM context_operations o
      LEFT JOIN context_decisions d ON d.user_id = o.user_id
        AND (d.resulting_operation_id = o.id OR d.compensation_operation_id = o.id)
      GROUP BY o.user_id, o.id
      ORDER BY o.updated_at_utc DESC, o.id DESC, o.user_id
      LIMIT $1
    `, [safeLimit]);
    const watermarks = await client.query(`
      SELECT w.user_id, w.relevant_sequence, w.processed_sequence,
        w.relevant_change_count, w.last_relevant_change_at_utc,
        w.active_workflow_execution_id, e.workflow_id, e.run_id, e.status AS workflow_status,
        w.updated_at_utc
      FROM context_discovery_watermarks w
      LEFT JOIN workflow_executions e ON e.id = w.active_workflow_execution_id
      ORDER BY w.updated_at_utc DESC, w.user_id
      LIMIT $1
    `, [safeLimit]);
    const notifications = await client.query(`
      SELECT id, user_id, kind, policies_id, title,
        CASE WHEN read_at_utc IS NULL THEN 'unread' ELSE 'read' END AS status,
        read_at_utc, created_at_utc
      FROM context_notifications
      ORDER BY created_at_utc DESC, id DESC
      LIMIT $1
    `, [safeLimit]);
    const agents = await client.query(`
      SELECT a.id, a.version, a.target, a.kind, a.status, a.title, a.summary,
        a.llm_provider, a.llm_model, a.llm_timeout_ms, a.fallback_description,
        a.source_module, a.updated_at_utc
      FROM agents a
      WHERE a.id = ANY($1::text[])
      ORDER BY array_position($1::text[], a.id)
    `, [GOAL_AGENT_IDS]);
    const services = await client.query(`
      WITH latest_heartbeats AS (
        SELECT DISTINCT ON (task_queue) task_queue, worker_identity, build_ref,
          started_at_utc, last_seen_at_utc, metadata_json
        FROM workflow_worker_heartbeats
        ORDER BY task_queue, last_seen_at_utc::timestamptz DESC
      ), execution_counts AS (
        SELECT workflow_definition_id, workflow_definition_version,
          COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active_count,
          COUNT(*) FILTER (WHERE status IN ('failed', 'needs_review'))::int AS failed_count,
          MAX(updated_at_utc) AS last_execution_at
        FROM workflow_executions
        GROUP BY workflow_definition_id, workflow_definition_version
      )
      SELECT d.id, d.version, d.title, d.status,
        d.task_queue AS definition_task_queue, COALESCE(h.task_queue, d.task_queue) AS task_queue,
        d.input_schema_version, d.output_schema_version, d.updated_at_utc,
        h.worker_identity, h.build_ref, h.started_at_utc, h.last_seen_at_utc,
        COALESCE(c.active_count, 0) AS active_count,
        COALESCE(c.failed_count, 0) AS failed_count, c.last_execution_at
      FROM workflow_definitions d
      LEFT JOIN LATERAL (
        SELECT heartbeat.*
        FROM latest_heartbeats heartbeat
        WHERE heartbeat.task_queue = d.task_queue
          OR (position('{environment}' in d.task_queue) > 0
            AND heartbeat.task_queue LIKE replace(d.task_queue, '{environment}', '%'))
        ORDER BY heartbeat.last_seen_at_utc::timestamptz DESC, heartbeat.task_queue
        LIMIT 1
      ) h ON TRUE
      LEFT JOIN execution_counts c ON c.workflow_definition_id = d.id
        AND c.workflow_definition_version = d.version
      WHERE d.id = ANY($1::text[])
         OR d.id LIKE 'goal.%'
         OR d.process_json::text LIKE '%activity.classifier%'
      ORDER BY d.id, d.version DESC
      LIMIT $2
    `, [GOAL_AGENT_IDS, safeLimit]);
    const aiLogs = await client.query(`
      SELECT id, agent_id, agent_version, dt, status, ai_title,
        workflow_id, run_id, attempt_number, trace_id
      FROM ai_logs
      WHERE agent_id = ANY($1::text[])
      ORDER BY dt DESC, id DESC
      LIMIT $2
    `, [GOAL_AGENT_IDS, safeLimit]);
    const relationEvents = await client.query(`
      SELECT id, event_id, event_type, event_action, status, ignore_reason,
        subject_type, subject_id, actor_type, actor_id, occurred_at_utc,
        received_at_utc, payload_version, trace_id
      FROM events
      WHERE event_domain = 'relation'
      ORDER BY domain_sequence DESC, id DESC
      LIMIT $1
    `, [safeLimit]);
    const labels = await client.query(`
      SELECT l.id, l.policies_id, l.decisions_id, l.source, l.accepted,
        l.confidence, l.created_at_utc
      FROM context_policy_labels l
      ORDER BY l.created_at_utc DESC, l.id DESC
      LIMIT $1
    `, [safeLimit]);
    const diagnostics = await client.query(`
      WITH item_types AS (
        SELECT roles.items_id, role_types.title_system AS role_key,
          activities.activity_type_id AS type_key
        FROM item_roles roles
        JOIN item_role_types role_types ON role_types.id = roles.item_role_types_id
        JOIN activities ON activities.item_roles_id = roles.id
        WHERE roles.status = 'active' AND role_types.title_system = 'activity'
        UNION ALL
        SELECT roles.items_id, role_types.title_system AS role_key,
          inbox.preliminary_section AS type_key
        FROM item_roles roles
        JOIN item_role_types role_types ON role_types.id = roles.item_role_types_id
        JOIN inbox ON inbox.item_roles_id = roles.id
        WHERE roles.status = 'active' AND role_types.title_system = 'inbox'
      )
      SELECT * FROM (
        SELECT 'orphan_or_invalid_endpoints' AS key,
          COUNT(*)::int AS count,
          'Active Relations with missing/deleted/cross-user endpoints' AS description
        FROM relations r
        LEFT JOIN items source ON source.id = r.source_items_id
        LEFT JOIN items target ON target.id = r.target_items_id
        WHERE r.status = 'active' AND (
          source.id IS NULL OR target.id IS NULL OR source.deleted_at_utc IS NOT NULL
          OR target.deleted_at_utc IS NOT NULL OR source.user_id IS DISTINCT FROM r.user_id
          OR target.user_id IS DISTINCT FROM r.user_id
          OR NOT EXISTS (
            SELECT 1
            FROM relation_type_endpoint_rules rule
            JOIN item_types source_type ON source_type.items_id = r.source_items_id
              AND source_type.role_key = rule.source_role_key
              AND source_type.type_key = rule.source_type_key
            JOIN item_types target_type ON target_type.items_id = r.target_items_id
              AND target_type.role_key = rule.target_role_key
              AND target_type.type_key = rule.target_type_key
            WHERE rule.relation_types_id = r.relation_types_id
          )
        )
        UNION ALL
        SELECT 'duplicate_active_edges', COUNT(*)::int,
          'Duplicate active logical edge groups'
        FROM (
          SELECT 1 FROM relations WHERE status = 'active'
          GROUP BY user_id, relation_types_id, source_items_id, target_items_id
          HAVING COUNT(*) > 1
        ) duplicates
        UNION ALL
        SELECT 'invalid_positions', COUNT(*)::int,
          'Active ordered Relations with null or non-dense positions'
        FROM (
          SELECT r.position,
            row_number() OVER (
              PARTITION BY r.user_id, r.relation_types_id, r.target_items_id
              ORDER BY r.position NULLS LAST, r.id
            ) - 1 AS expected
          FROM relations r
          JOIN relation_types t ON t.id = r.relation_types_id
          WHERE r.status = 'active' AND t.is_ordered = 1
        ) ordered_relations
        WHERE position IS DISTINCT FROM expected::int
        UNION ALL
        SELECT 'stale_policy_versions', COUNT(*)::int,
          'Active policies whose exact agent version is no longer current'
        FROM context_policies p JOIN agents a ON a.id = p.agent_id
        WHERE p.state = 'active' AND p.agent_version <> a.version
        UNION ALL
        SELECT 'overdue_audits', COUNT(*)::int,
          'Pending or overdue audit batches past due_at_utc'
        FROM context_audit_batches
        WHERE status = 'overdue' OR (status = 'pending' AND due_at_utc::timestamptz < now())
        UNION ALL
        SELECT 'unlinked_outcomes', COUNT(*)::int,
          'Applied decisions without resulting operation or rejected outcomes without resolution'
        FROM context_decisions
        WHERE status IN ('accepted', 'auto_accepted', 'undone', 'audit_rejected')
          AND resulting_operation_id IS NULL
      ) diagnostics
      ORDER BY key
    `);
    await client.query("COMMIT");
    committed = true;
    return {
      limit: safeLimit,
      relationTypes: relationTypes.rows,
      relations,
      relationPagination: {
        page: safeRelationPage,
        pageSize: safeLimit,
        hasPrevious: safeRelationPage > 1,
        hasNext: relationResult.rows.length > safeLimit,
      },
      relationEvents: relationEvents.rows,
      decisions: decisions.rows,
      policies: policies.rows,
      labels: labels.rows,
      audits: audits.rows,
      operations: operations.rows,
      watermarks: watermarks.rows,
      notifications: notifications.rows,
      agents: agents.rows,
      services: services.rows,
      aiLogs: aiLogs.rows,
      diagnostics: diagnostics.rows,
    };
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await db.close();
  }
}
