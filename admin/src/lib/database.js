import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;

export const DATABASE_URL_ENV = "BRAI_DATABASE_URL";
export const PAGE_SIZE = 50;
export const WORKFLOW_RUN_PAGE_SIZE = 50;
export const DEFAULT_SORT_DIRECTION = "desc";
const CREATED_COLUMN_NAMES = ["created_at_utc", "created_at", "createdAt", "created_on", "creation_date"];
const USER_TABLE_NAMES = new Set(["activities", "app_settings", "inbox"]);
const USER_TABLE_PREFIXES = ["activity_", "focus_", "timer_"];
const SYSTEM_TABLE_NAMES = new Set(["events", "item_roles", "item_role_types", "items", "logs", "relations"]);
const SYSTEM_TABLE_PREFIXES = ["schema_", "table_", "build_", "deployment_", "version_", "agent_", "ai_", "role_", "workflow_", "brai_cmd_", "relation_", "context_"];
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const WORKFLOW_DIAGRAM_CACHE = new Map();
const WORKFLOW_STUCK_MINUTES = 5;

export function resolveDatabaseUrl() {
  const databaseUrl = process.env[DATABASE_URL_ENV];
  if (!databaseUrl) throw new Error(`${DATABASE_URL_ENV} is required for Brai Admin`);

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${DATABASE_URL_ENV} must be a valid Postgres connection URL`);
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) throw new Error(`${DATABASE_URL_ENV} must use postgres:// or postgresql://`);

  return databaseUrl;
}

export function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

export function classifyTableGroup(tableName) {
  const name = String(tableName);
  if (USER_TABLE_NAMES.has(name) || USER_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) return "user";
  if (SYSTEM_TABLE_NAMES.has(name)) return "system";
  return SYSTEM_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)) ? "system" : "user";
}

export function openDatabase(databaseUrl = resolveDatabaseUrl()) {
  const pool = new Pool({
    application_name: "brai-admin",
    connectionString: databaseUrl,
    max: 1,
  });

  return {
    connect: () => pool.connect(),
    query: (sql, values) => pool.query(sql, values),
    close: () => pool.end(),
  };
}

export function openReadOnlyDatabase(databaseUrl = resolveDatabaseUrl()) {
  return openDatabase(databaseUrl);
}

export async function readDatabaseView({
  databaseUrl = resolveDatabaseUrl(),
  tableName,
  page = 1,
  pageSize = PAGE_SIZE,
  sortDirection = DEFAULT_SORT_DIRECTION,
} = {}) {
  const db = openReadOnlyDatabase(databaseUrl);
  const client = await db.connect();
  let done = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    const descriptions = await readTableDescriptions(client);
    const tables = (await listTables(client)).map((table) => ({
      ...table,
      description: descriptions.get(table.name) ?? null,
    }));
    const selected = chooseTable(tables, tableName);
    const stats = await readStats(client, tables);
    if (!selected) {
      await client.query("COMMIT");
      done = true;
      return {
        stats,
        tables,
        selectedTable: null,
        tableDescription: null,
        columns: [],
        indexes: [],
        foreignKeys: [],
        referencedBy: [],
        rows: [],
        page: 1,
        pageSize,
        pageCount: 1,
        rowCount: 0,
      };
    }

    const columns = await readColumns(client, selected.name);
    const rowSort = resolveRowSort(columns, sortDirection, selected.name);
    const rowCount = selected.rowCount;
    const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
    const safePage = Math.min(Math.max(toPositiveInteger(page, 1), 1), pageCount);
    const offset = (safePage - 1) * pageSize;
    const foreignKeys = (await readForeignKeys(client, selected.name)).map((key) => describeForeignKey(key, descriptions));

    const view = {
      stats,
      tables,
      selectedTable: selected,
      tableDescription: selected.description,
      columns,
      indexes: await readIndexes(client, selected.name),
      foreignKeys,
      referencedBy: await readIncomingForeignKeys(client, selected.name, tables, descriptions),
      rows: await readRows(client, selected.name, rowSort, pageSize, offset),
      page: safePage,
      pageSize,
      pageCount,
      rowCount,
    };
    await client.query("COMMIT");
    done = true;
    return view;
  } finally {
    if (!done) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await db.close();
  }
}

export async function readPrimaryUserId(databaseUrl = resolveDatabaseUrl()) {
  const db = openReadOnlyDatabase(databaseUrl);
  try {
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1 LIMIT 1", ["primary_user_id"]);
    const value = result.rows[0]?.value;
    return typeof value === "string" && value ? value : null;
  } finally {
    await db.close();
  }
}

export async function readWorkflowAdminSummary(options = {}) {
  const normalized = normalizeWorkflowAdminOptions(options);
  const db = openReadOnlyDatabase(normalized.databaseUrl);
  const client = await db.connect();
  let done = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    const definitions = await client.query(`
      WITH metrics AS (
        SELECT workflow_definition_id,
          workflow_definition_version,
          COUNT(*) FILTER (WHERE updated_at_utc::timestamptz >= now() - interval '24 hours')::int AS runs_24h,
          COUNT(*) FILTER (WHERE status = 'completed' AND updated_at_utc::timestamptz >= now() - interval '24 hours')::int AS completed_24h,
          COUNT(*) FILTER (WHERE status IN ('failed', 'needs_review') AND updated_at_utc::timestamptz >= now() - interval '24 hours')::int AS failed_24h,
          COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active_runs,
          COUNT(*) FILTER (
            WHERE status IN ('queued', 'running')
              AND updated_at_utc::timestamptz < now() - ($1::text || ' minutes')::interval
          )::int AS stuck_runs,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (completed_at_utc::timestamptz - started_at_utc::timestamptz)) * 1000
          ) FILTER (
            WHERE completed_at_utc IS NOT NULL
              AND started_at_utc IS NOT NULL
              AND updated_at_utc::timestamptz >= now() - interval '24 hours'
          )::int AS p50_ms,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (completed_at_utc::timestamptz - started_at_utc::timestamptz)) * 1000
          ) FILTER (
            WHERE completed_at_utc IS NOT NULL
              AND started_at_utc IS NOT NULL
              AND updated_at_utc::timestamptz >= now() - interval '24 hours'
          )::int AS p95_ms,
          MAX(updated_at_utc) AS last_execution_at
        FROM workflow_executions
        GROUP BY workflow_definition_id, workflow_definition_version
      ),
      latest_heartbeats AS (
        SELECT DISTINCT ON (task_queue) task_queue, worker_identity, build_ref,
          started_at_utc, last_seen_at_utc, metadata_json
        FROM workflow_worker_heartbeats
        ORDER BY task_queue, last_seen_at_utc::timestamptz DESC
      )
      SELECT d.id, d.version, d.title, d.description, d.status, d.task_queue,
        d.steps_json, d.diagram_mermaid, d.process_json,
        d.input_schema_version, d.input_schema_json,
        d.output_schema_version, d.output_schema_json, d.updated_at_utc,
        COALESCE(jsonb_agg(DISTINCT r.id) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS role_contract_ids,
        COALESCE(m.runs_24h, 0) AS runs_24h,
        COALESCE(m.completed_24h, 0) AS completed_24h,
        COALESCE(m.failed_24h, 0) AS failed_24h,
        COALESCE(m.active_runs, 0) AS active_runs,
        COALESCE(m.stuck_runs, 0) AS stuck_runs,
        COALESCE(m.p50_ms, 0) AS p50_ms,
        COALESCE(m.p95_ms, 0) AS p95_ms,
        m.last_execution_at,
        h.worker_identity, h.build_ref, h.started_at_utc AS worker_started_at_utc,
        h.last_seen_at_utc AS worker_last_seen_at_utc, h.metadata_json AS worker_metadata_json
      FROM workflow_definitions d
      LEFT JOIN role_contracts r
        ON r.workflow_definition_id = d.id
       AND r.workflow_definition_version = d.version
      LEFT JOIN metrics m
        ON m.workflow_definition_id = d.id
       AND m.workflow_definition_version = d.version
      LEFT JOIN latest_heartbeats h ON h.task_queue = d.task_queue
      GROUP BY d.id, d.version, d.title, d.description, d.status, d.task_queue,
        d.steps_json, d.diagram_mermaid, d.process_json, d.input_schema_version,
        d.input_schema_json, d.output_schema_version, d.output_schema_json,
        d.updated_at_utc, m.runs_24h, m.completed_24h, m.failed_24h,
        m.active_runs, m.stuck_runs, m.p50_ms, m.p95_ms, m.last_execution_at,
        h.worker_identity, h.build_ref, h.started_at_utc, h.last_seen_at_utc,
        h.metadata_json
      ORDER BY CASE d.status WHEN 'active' THEN 0 ELSE 1 END, d.id, d.version DESC
    `, [WORKFLOW_STUCK_MINUTES]);
    const workflows = definitions.rows.map(formatWorkflowSummary);
    const selectedWorkflow = selectWorkflow(workflows, normalized.workflowId, normalized.version);
    const runs = selectedWorkflow
      ? await readWorkflowRuns(client, selectedWorkflow, normalized)
      : { rows: [], nextCursor: null, pageSize: WORKFLOW_RUN_PAGE_SIZE };
    const selectedExecution = await readSelectedExecution(client, selectedWorkflow, normalized.runId, runs.rows[0]);
    await client.query("COMMIT");
    done = true;

    const hydratedWorkflow = selectedWorkflow ? await hydrateWorkflowDiagrams(selectedWorkflow) : null;
    const hydratedExecution = selectedExecution && hydratedWorkflow
      ? await hydrateExecutionDiagram(hydratedWorkflow, selectedExecution)
      : selectedExecution;
    return {
      workflows,
      selectedWorkflow: hydratedWorkflow,
      runs,
      selectedExecution: hydratedExecution,
      definitions: workflows,
      executions: runs.rows,
    };
  } finally {
    if (!done) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await db.close();
  }
}

export async function readRoleContractsAdmin(options = {}) {
  const normalized = normalizeRoleAdminOptions(options);
  const db = openReadOnlyDatabase(normalized.databaseUrl);
  const client = await db.connect();
  let done = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    const result = await client.query(`
      WITH role_counts AS (
        SELECT item_role_types_id,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
          COUNT(*) FILTER (WHERE status = 'ended')::int AS ended_count,
          COUNT(*) FILTER (WHERE status = 'deleted')::int AS deleted_count,
          COUNT(*) FILTER (WHERE items_id IS NULL)::int AS orphan_item_roles_count
        FROM item_roles
        GROUP BY item_role_types_id
      )
      SELECT c.*, t.title_system AS role_key, t.title AS role_title,
        w.title AS workflow_title, w.description AS workflow_description,
        w.status AS workflow_status, w.task_queue, w.process_json,
        w.input_schema_json, w.output_schema_json,
        COALESCE(rc.active_count, 0) AS active_count,
        COALESCE(rc.ended_count, 0) AS ended_count,
        COALESCE(rc.deleted_count, 0) AS deleted_count,
        COALESCE(rc.orphan_item_roles_count, 0) AS orphan_item_roles_count
      FROM role_contracts c
      JOIN item_role_types t ON t.id = c.item_role_types_id
      LEFT JOIN workflow_definitions w
        ON w.id = c.workflow_definition_id
       AND w.version = c.workflow_definition_version
      LEFT JOIN role_counts rc ON rc.item_role_types_id = c.item_role_types_id
      ORDER BY t.title ASC, c.id ASC
    `);
    const schemaFacts = await readRoleSchemaFacts(client, result.rows);
    const orphanCounts = await readRolePayloadOrphans(client, result.rows, schemaFacts);
    await client.query("COMMIT");
    done = true;

    const roles = await Promise.all(result.rows.map((row) => formatRoleSummary(row, schemaFacts, orphanCounts)));
    roles.sort(roleSort);
    const selectedRole = selectRole(roles, normalized.roleId);
    return {
      roles,
      selectedRole,
      rows: roles,
    };
  } finally {
    if (!done) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await db.close();
  }
}

async function renderMermaid(source, cacheKey = "") {
  if (typeof source !== "string" || !source.trim()) return null;
  const key = cacheKey || crypto.createHash("sha1").update(source).digest("hex");
  if (WORKFLOW_DIAGRAM_CACHE.has(key)) return WORKFLOW_DIAGRAM_CACHE.get(key);
  try {
    const baseUrl = new URL(process.env.BRAI_KROKI_URL ?? "http://127.0.0.1:8000");
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") return null;
    const response = await fetch(new URL("/mermaid/svg", baseUrl), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: source,
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const svg = Buffer.from(await response.arrayBuffer()).toString("base64");
    const dataUrl = `data:image/svg+xml;base64,${svg}`;
    WORKFLOW_DIAGRAM_CACHE.set(key, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

function normalizeWorkflowAdminOptions(options) {
  if (typeof options === "string") return { databaseUrl: options };
  return {
    databaseUrl: options.databaseUrl ?? resolveDatabaseUrl(),
    workflowId: cleanOption(options.workflowId),
    version: toPositiveInteger(options.version, null),
    runId: cleanOption(options.runId),
    cursor: cleanOption(options.cursor),
    status: cleanOption(options.status),
    role: cleanOption(options.role),
    owner: cleanOption(options.owner),
    health: cleanOption(options.health),
    stuck: cleanOption(options.stuck),
    hasError: cleanOption(options.hasError),
    dateFrom: cleanOption(options.dateFrom),
    dateTo: cleanOption(options.dateTo),
  };
}

function normalizeRoleAdminOptions(options) {
  if (typeof options === "string") return { databaseUrl: options };
  return {
    databaseUrl: options.databaseUrl ?? resolveDatabaseUrl(),
    roleId: cleanOption(options.roleId),
  };
}

function cleanOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatWorkflowSummary(row) {
  const process = parseJsonObject(row.process_json);
  const roleContractIds = parseJsonArray(row.role_contract_ids);
  const workerHealth = workerHealthFor(row.worker_last_seen_at_utc);
  const runs24h = Number(row.runs_24h ?? 0);
  const completed24h = Number(row.completed_24h ?? 0);
  const failed24h = Number(row.failed_24h ?? 0);
  const stuckRuns = Number(row.stuck_runs ?? 0);
  const health = stuckRuns > 0 || workerHealth.status === "offline"
    ? "broken"
    : failed24h > 0 || workerHealth.status === "stale"
      ? "degraded"
      : "healthy";
  return {
    id: row.id,
    version: Number(row.version),
    title: row.title,
    description: row.description,
    status: row.status,
    taskQueue: row.task_queue,
    steps: parseJsonArray(row.steps_json),
    diagramMermaid: row.diagram_mermaid,
    process,
    inputSchemaVersion: row.input_schema_version,
    inputSchemaJson: row.input_schema_json,
    outputSchemaVersion: row.output_schema_version,
    outputSchemaJson: row.output_schema_json,
    updatedAtUtc: row.updated_at_utc,
    roleContractIds,
    runs24h,
    successRate24h: runs24h > 0 ? completed24h / runs24h : null,
    failed24h,
    p50Ms: Number(row.p50_ms ?? 0),
    p95Ms: Number(row.p95_ms ?? 0),
    activeRuns: Number(row.active_runs ?? 0),
    stuckRuns,
    lastExecutionAt: row.last_execution_at,
    worker: {
      identity: row.worker_identity ?? "",
      buildRef: row.build_ref ?? "",
      startedAtUtc: row.worker_started_at_utc ?? "",
      lastSeenAtUtc: row.worker_last_seen_at_utc ?? "",
      metadata: parseJsonObject(row.worker_metadata_json),
      ...workerHealth,
    },
    health,
    healthReason: workflowHealthReason({ health, stuckRuns, failed24h, workerHealth }),
  };
}

function workerHealthFor(lastSeenAtUtc) {
  if (!lastSeenAtUtc) return { status: "offline", reason: "Heartbeat worker не найден." };
  const ageMs = Date.now() - Date.parse(lastSeenAtUtc);
  if (!Number.isFinite(ageMs) || ageMs > 120_000) return { status: "offline", reason: "Последний heartbeat старше 120 секунд." };
  if (ageMs > 30_000) return { status: "stale", reason: "Последний heartbeat старше 30 секунд." };
  return { status: "online", reason: "Heartbeat свежий." };
}

function workflowHealthReason({ health, stuckRuns, failed24h, workerHealth }) {
  if (stuckRuns > 0) return `${stuckRuns} запусков не обновлялись больше ${WORKFLOW_STUCK_MINUTES} минут.`;
  if (workerHealth.status !== "online") return workerHealth.reason;
  if (failed24h > 0) return `${failed24h} запусков за 24 часа завершились ошибкой или needs_review.`;
  return health === "healthy" ? "Критичных признаков деградации не найдено." : "Есть предупреждения по метрикам выполнения.";
}

function selectWorkflow(workflows, workflowId, version) {
  if (!workflows.length) return null;
  if (workflowId) {
    const exact = workflows.find((workflow) => workflow.id === workflowId && (!version || workflow.version === version));
    if (exact) return exact;
  }
  return workflows.find((workflow) => workflow.status === "active") ?? workflows[0];
}

async function readWorkflowRuns(client, workflow, options) {
  const params = [workflow.id, workflow.version, WORKFLOW_STUCK_MINUTES];
  const filters = ["e.workflow_definition_id = $1", "e.workflow_definition_version = $2"];
  if (options.status && options.status !== "all") {
    params.push(options.status);
    filters.push(`e.status = $${params.length}`);
  }
  if (options.hasError === "1") filters.push("e.last_error IS NOT NULL");
  if (options.stuck === "1") {
    filters.push("e.status IN ('queued', 'running') AND e.updated_at_utc::timestamptz < now() - ($3::text || ' minutes')::interval");
  }
  if (options.dateFrom) {
    params.push(options.dateFrom);
    filters.push(`e.created_at_utc::timestamptz >= $${params.length}::timestamptz`);
  }
  if (options.dateTo) {
    params.push(options.dateTo);
    filters.push(`e.created_at_utc::timestamptz <= $${params.length}::timestamptz`);
  }
  const cursor = decodeRunCursor(options.cursor);
  if (cursor) {
    params.push(cursor.updatedAtUtc, cursor.id);
    filters.push(`(e.updated_at_utc < $${params.length - 1} OR (e.updated_at_utc = $${params.length - 1} AND e.id < $${params.length}))`);
  }
  params.push(WORKFLOW_RUN_PAGE_SIZE + 1);
  const result = await client.query(`
    SELECT e.id, e.workflow_id, e.run_id, e.workflow_definition_id,
      e.workflow_definition_version, e.role_contract_id, e.raw_record_id,
      e.subject_kind, e.subject_id, e.trigger_kind, e.trigger_revision,
      e.watermark_from, e.watermark_to,
      e.status, e.current_step, e.attempt_count, e.last_error,
      e.started_at_utc, e.completed_at_utc, e.created_at_utc, e.updated_at_utc,
      e.trace_status,
      CASE
        WHEN e.started_at_utc IS NOT NULL AND e.completed_at_utc IS NOT NULL
          THEN GREATEST(0, floor(extract(epoch FROM (e.completed_at_utc::timestamptz - e.started_at_utc::timestamptz)) * 1000)::int)
        ELSE NULL
      END AS duration_ms,
      (e.status IN ('queued', 'running')
        AND e.updated_at_utc::timestamptz < now() - ($3::text || ' minutes')::interval) AS stuck,
      COUNT(s.id)::int AS recorded_steps
    FROM workflow_executions e
    LEFT JOIN workflow_execution_steps s ON s.workflow_execution_id = e.id
    WHERE ${filters.join(" AND ")}
    GROUP BY e.id
    ORDER BY e.updated_at_utc DESC, e.id DESC
    LIMIT $${params.length}
  `, params);
  const rows = result.rows.slice(0, WORKFLOW_RUN_PAGE_SIZE).map(formatWorkflowRun);
  const next = result.rows[WORKFLOW_RUN_PAGE_SIZE];
  return {
    rows,
    nextCursor: next ? encodeRunCursor(next) : null,
    pageSize: WORKFLOW_RUN_PAGE_SIZE,
  };
}

function formatWorkflowRun(row) {
  return {
    id: Number(row.id),
    workflowId: row.workflow_id,
    runId: row.run_id ?? "",
    workflowDefinitionId: row.workflow_definition_id,
    workflowDefinitionVersion: Number(row.workflow_definition_version),
    roleContractId: row.role_contract_id,
    rawRecordId: row.raw_record_id ?? "",
    subjectKind: row.subject_kind ?? (row.raw_record_id ? "raw" : ""),
    subjectId: row.subject_id ?? row.raw_record_id ?? "",
    triggerKind: row.trigger_kind ?? "",
    triggerRevision: row.trigger_revision == null ? null : Number(row.trigger_revision),
    watermarkFrom: row.watermark_from == null ? null : Number(row.watermark_from),
    watermarkTo: row.watermark_to == null ? null : Number(row.watermark_to),
    status: row.status,
    currentStep: row.current_step,
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: row.last_error ?? "",
    startedAtUtc: row.started_at_utc ?? "",
    completedAtUtc: row.completed_at_utc ?? "",
    createdAtUtc: row.created_at_utc ?? "",
    updatedAtUtc: row.updated_at_utc ?? "",
    traceStatus: row.trace_status ?? "unavailable",
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    stuck: row.stuck === true,
    recordedSteps: Number(row.recorded_steps ?? 0),
  };
}

async function readSelectedExecution(client, workflow, runId, fallbackRun) {
  if (!workflow) return null;
  let summary = fallbackRun ?? null;
  if (runId) {
    const result = await client.query(`
      SELECT e.id, e.workflow_id, e.run_id, e.workflow_definition_id,
        e.workflow_definition_version, e.role_contract_id, e.raw_record_id,
        e.subject_kind, e.subject_id, e.trigger_kind, e.trigger_revision,
        e.watermark_from, e.watermark_to,
        e.status, e.current_step, e.attempt_count, e.last_error,
        e.started_at_utc, e.completed_at_utc, e.created_at_utc, e.updated_at_utc,
        e.trace_status,
        CASE
          WHEN e.started_at_utc IS NOT NULL AND e.completed_at_utc IS NOT NULL
            THEN GREATEST(0, floor(extract(epoch FROM (e.completed_at_utc::timestamptz - e.started_at_utc::timestamptz)) * 1000)::int)
          ELSE NULL
        END AS duration_ms,
        false AS stuck,
        COUNT(s.id)::int AS recorded_steps
      FROM workflow_executions e
      LEFT JOIN workflow_execution_steps s ON s.workflow_execution_id = e.id
      WHERE e.workflow_definition_id = $1
        AND e.workflow_definition_version = $2
        AND e.run_id IS NOT DISTINCT FROM $3
      GROUP BY e.id
      ORDER BY e.updated_at_utc DESC, e.id DESC
      LIMIT 1
    `, [workflow.id, workflow.version, runId || null]);
    summary = result.rows[0] ? formatWorkflowRun(result.rows[0]) : summary;
  }
  if (!summary) return null;
  const steps = await client.query(`
      SELECT id, step_key, attempt, status, started_at_utc, completed_at_utc,
        duration_ms, activity_type, agent_id, ai_log_id, error_code,
        error_summary, metadata_json
      FROM workflow_execution_steps
      WHERE workflow_execution_id = $1
      ORDER BY COALESCE(started_at_utc, completed_at_utc, updated_at_utc), attempt, id
    `, [summary.id]);
  const aiLogs = await client.query(`
      SELECT id, agent_id, agent_version, dt, status, ai_title,
        workflow_id, run_id, attempt_number
      FROM ai_logs
      WHERE workflow_id = $1
        AND run_id IS NOT DISTINCT FROM $2
      ORDER BY dt ASC, id ASC
      LIMIT 50
    `, [summary.workflowId, summary.runId || null]);
  const events = await client.query(`
      SELECT id, event_type, event_action, status, occurred_at_utc, item_roles_id
      FROM events
      WHERE subject_id = $1
      ORDER BY occurred_at_utc ASC, id ASC
      LIMIT 50
    `, [summary.subjectId || summary.rawRecordId]);
  const logs = await client.query(`
      SELECT id, dt, operation, status, reason
      FROM logs
      WHERE json_data::text LIKE $1
      ORDER BY dt ASC, id ASC
      LIMIT 50
    `, [`%${summary.workflowId}%`]);
  return {
    ...summary,
    steps: steps.rows.map((step) => ({ ...step, metadata_json: parseJsonObject(step.metadata_json) })),
    aiLogs: aiLogs.rows,
    events: events.rows,
    logs: logs.rows,
  };
}

async function hydrateWorkflowDiagrams(workflow) {
  const sources = {
    orchestration: processToMermaid(workflow.process, "orchestration"),
    data: processToMermaid(workflow.process, "data"),
    errors: processToMermaid(workflow.process, "errors"),
  };
  const hash = processHash(workflow);
  const diagrams = {};
  for (const [mode, source] of Object.entries(sources)) {
    diagrams[mode] = {
      source,
      dataUrl: await renderMermaid(source, `${workflow.id}:${workflow.version}:${hash}:${mode}`),
    };
  }
  return { ...workflow, diagrams };
}

async function hydrateExecutionDiagram(workflow, execution) {
  const source = processToMermaid(workflow.process, "execution", execution.steps ?? []);
  return {
    ...execution,
    diagram: {
      source,
      dataUrl: await renderMermaid(source, `${workflow.id}:${workflow.version}:${processHash(workflow)}:run:${execution.id}:${execution.updatedAtUtc}`),
    },
  };
}

function processHash(workflow) {
  return crypto.createHash("sha1").update(JSON.stringify(workflow.process ?? {})).digest("hex").slice(0, 12);
}

function processToMermaid(process, mode, executionSteps = []) {
  const steps = Array.isArray(process.steps) ? process.steps : [];
  const edges = Array.isArray(process.edges) ? process.edges : [];
  const terminals = Array.isArray(process.terminals) ? process.terminals : [];
  const statusByStep = new Map(executionSteps.map((step) => [step.step_key, step.status]));
  const lines = ["flowchart LR"];
  if (mode === "data") {
    const tables = new Set();
    for (const step of steps) {
      for (const table of arrayText(step.reads)) tables.add(table);
      for (const table of arrayText(step.writes)) tables.add(table);
    }
    for (const table of tables) lines.push(`  ${nodeId(`table_${table}`)}[${quoteMermaid(table)}]`);
    for (const step of steps) {
      const stepNode = nodeId(`step_${step.id}`);
      lines.push(`  ${stepNode}(${quoteMermaid(step.label ?? step.id)})`);
      for (const table of arrayText(step.reads)) lines.push(`  ${nodeId(`table_${table}`)} -. read .-> ${stepNode}`);
      for (const table of arrayText(step.writes)) lines.push(`  ${stepNode} -- write --> ${nodeId(`table_${table}`)}`);
    }
    return lines.join("\n");
  }

  const laneGroups = new Map();
  for (const step of steps) {
    const lane = cleanMermaidId(step.lane ?? "workflow");
    laneGroups.set(lane, [...(laneGroups.get(lane) ?? []), step]);
  }
  for (const [lane, laneSteps] of laneGroups) {
    lines.push(`  subgraph lane_${lane}[${quoteMermaid(laneLabel(process, lane))}]`);
    for (const step of laneSteps) {
      const suffix = mode === "execution" ? `\\n${statusByStep.get(step.id) ?? "not_recorded"}` : "";
      lines.push(`    ${nodeId(step.id)}[${quoteMermaid(`${step.label ?? step.id}${suffix}`)}]`);
    }
    lines.push("  end");
  }
  const filteredEdges = mode === "errors"
    ? edges.filter((edge) => ["failure", "retry", "timeout", "recovery"].includes(edge.kind))
    : edges;
  for (const edge of filteredEdges.length ? filteredEdges : edges) {
    const target = steps.some((step) => step.id === edge.to) ? nodeId(edge.to) : nodeId(`terminal_${edge.to}`);
    if (!steps.some((step) => step.id === edge.to)) lines.push(`  ${target}([${quoteMermaid(edge.to)}])`);
    lines.push(`  ${nodeId(edge.from)} -- ${quoteMermaid(edge.kind ?? "next")}${edge.condition ? `: ${quoteMermaid(edge.condition)}` : ""} --> ${target}`);
  }
  for (const terminal of terminals) {
    lines.push(`  ${nodeId(`terminal_${terminal.id}`)}([${quoteMermaid(terminal.status ?? terminal.id)}])`);
  }
  return lines.join("\n");
}

function laneLabel(process, laneId) {
  return (Array.isArray(process.lanes) ? process.lanes : []).find((lane) => cleanMermaidId(lane.id) === laneId)?.label ?? laneId;
}

function nodeId(value) {
  return `n_${cleanMermaidId(value)}`;
}

function cleanMermaidId(value) {
  return String(value ?? "node").replace(/[^a-zA-Z0-9_]/g, "_");
}

function quoteMermaid(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function arrayText(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function encodeRunCursor(row) {
  return Buffer.from(JSON.stringify({ updatedAtUtc: row.updated_at_utc, id: Number(row.id) })).toString("base64url");
}

function decodeRunCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed.updatedAtUtc === "string" && Number.isInteger(parsed.id) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readRoleSchemaFacts(client, rows) {
  const payloadTables = [...new Set(rows.map((row) => row.payload_table).filter(Boolean))];
  if (!payloadTables.length) return new Map();
  const columns = await client.query(`
      SELECT table_name, column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [payloadTables]);
  const foreignKeys = await client.query(`
      SELECT source_table.relname AS table_name,
        source_column.attname AS column_name,
        target_table.relname AS target_table,
        target_column.attname AS target_column,
        constraints.confdeltype AS on_delete
      FROM pg_constraint AS constraints
      JOIN pg_class AS source_table ON source_table.oid = constraints.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = source_table.relnamespace
      JOIN LATERAL unnest(constraints.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
      JOIN pg_attribute AS source_column
        ON source_column.attrelid = constraints.conrelid
       AND source_column.attnum = key.attnum
      JOIN pg_class AS target_table ON target_table.oid = constraints.confrelid
      JOIN pg_attribute AS target_column
        ON target_column.attrelid = constraints.confrelid
       AND target_column.attnum = constraints.confkey[key.ordinality]
      WHERE constraints.contype = 'f'
        AND namespace.nspname = current_schema()
        AND source_table.relname = ANY($1::text[])
    `, [payloadTables]);
  const facts = new Map();
  for (const table of payloadTables) facts.set(table, { columns: new Map(), foreignKeys: [] });
  for (const column of columns.rows) facts.get(column.table_name)?.columns.set(column.column_name, column);
  for (const key of foreignKeys.rows) facts.get(key.table_name)?.foreignKeys.push(key);
  return facts;
}

async function readRolePayloadOrphans(client, rows, schemaFacts) {
  const selects = [];
  for (const row of rows) {
    const table = row.payload_table;
    const column = row.link_column;
    if (!schemaFacts.get(table)?.columns.has(column)) continue;
    selects.push(`
      SELECT ${quoteLiteral(row.id)} AS role_id,
        COUNT(*) FILTER (WHERE payload.${quoteIdentifier(column)} IS NOT NULL AND role.id IS NULL)::int AS orphan_payload_rows
      FROM ${quoteIdentifier(table)} AS payload
      LEFT JOIN item_roles AS role ON role.id = payload.${quoteIdentifier(column)}
    `);
  }
  if (!selects.length) return new Map();
  const result = await client.query(selects.join(" UNION ALL "));
  return new Map(result.rows.map((row) => [row.role_id, Number(row.orphan_payload_rows ?? 0)]));
}

async function formatRoleSummary(row, schemaFacts, orphanCounts) {
  const facts = schemaFacts.get(row.payload_table);
  const tableExists = Boolean(facts);
  const linkColumn = facts?.columns.get(row.link_column);
  const linkFk = facts?.foreignKeys.find((key) => key.column_name === row.link_column && key.target_table === "item_roles");
  const inputSchema = parseJsonObject(row.input_schema_json);
  const outputSchema = parseJsonObject(row.output_schema_json);
  const lifecycle = parseJsonObject(row.lifecycle_json);
  const eventRules = parseJsonObject(row.event_rules_json);
  const diagnostics = [
    diagnostic("Payload table exists", tableExists, tableExists ? `${row.payload_table} найдена.` : `${row.payload_table} отсутствует.`),
    diagnostic("Link column exists", Boolean(linkColumn), linkColumn ? `${row.payload_table}.${row.link_column} найдена.` : `${row.link_column} отсутствует в ${row.payload_table}.`),
    diagnostic("FK points to item_roles", Boolean(linkFk), linkFk ? "FK направлен на item_roles.id." : "FK на item_roles.id не найден."),
    diagnostic("Role type exists", Boolean(row.role_key), row.role_key ? `${row.role_key} найден.` : "item_role_types row отсутствует."),
    diagnostic("Workflow definition exists", !row.workflow_definition_id || Boolean(row.workflow_title), row.workflow_definition_id ? (row.workflow_title ? "Workflow/version найдены." : "Workflow/version отсутствуют.") : "Для этой роли workflow не требуется."),
    diagnostic("Input schema exists", !row.workflow_definition_id || Boolean(row.input_schema_version && Object.keys(inputSchema).length), row.workflow_definition_id ? "Input schema доступна." : "Input schema не требуется без workflow."),
    diagnostic("Output schema exists", !row.workflow_definition_id || Boolean(row.output_schema_version && Object.keys(outputSchema).length), row.workflow_definition_id ? "Output schema доступна." : "Output schema не требуется без workflow."),
    diagnostic("Orphan payload rows absent", (orphanCounts.get(row.id) ?? 0) === 0, `${orphanCounts.get(row.id) ?? 0} payload rows без item_roles.`),
    diagnostic("Orphan item_roles absent", Number(row.orphan_item_roles_count ?? 0) === 0, `${Number(row.orphan_item_roles_count ?? 0)} item_roles без items.`),
  ];
  const broken = diagnostics.some((item) => item.status === "broken");
  const warning = !broken && diagnostics.some((item) => item.status === "warning");
  const health = broken ? "broken" : warning ? "warning" : "healthy";
  const role = {
    id: row.id,
    roleKey: row.role_key,
    title: row.role_title,
    purpose: rolePurpose(row.id),
    owner: row.owner,
    payloadTable: row.payload_table,
    linkColumn: row.link_column,
    workflowDefinitionId: row.workflow_definition_id ?? "",
    workflowDefinitionVersion: row.workflow_definition_version ? Number(row.workflow_definition_version) : null,
    workflowTitle: row.workflow_title ?? "",
    workflowStatus: row.workflow_status ?? "",
    taskQueue: row.task_queue ?? "",
    activeCount: Number(row.active_count ?? 0),
    endedCount: Number(row.ended_count ?? 0),
    deletedCount: Number(row.deleted_count ?? 0),
    orphanPayloadRows: orphanCounts.get(row.id) ?? 0,
    orphanItemRoles: Number(row.orphan_item_roles_count ?? 0),
    lifecycle,
    eventRules,
    inputSchemaVersion: row.input_schema_version ?? "",
    outputSchemaVersion: row.output_schema_version ?? "",
    inputSchema,
    outputSchema,
    dataLinks: roleDataLinks(row, linkColumn, linkFk),
    diagnostics,
    health,
    healthReason: broken ? diagnostics.find((item) => item.status === "broken")?.reason : "Контракт согласован с текущей схемой.",
    rawDefinition: {
      lifecycle_json: row.lifecycle_json,
      event_rules_json: row.event_rules_json,
      process_json: row.process_json,
    },
  };
  const dataSource = roleDataDiagramSource(role);
  const lifecycleSource = roleLifecycleDiagramSource(role);
  return {
    ...role,
    diagrams: {
      data: { source: dataSource, dataUrl: await renderMermaid(dataSource, `role:${role.id}:data:${crypto.createHash("sha1").update(dataSource).digest("hex").slice(0, 12)}`) },
      lifecycle: { source: lifecycleSource, dataUrl: await renderMermaid(lifecycleSource, `role:${role.id}:lifecycle:${crypto.createHash("sha1").update(lifecycleSource).digest("hex").slice(0, 12)}`) },
    },
  };
}

function diagnostic(name, ok, reason) {
  return { name, status: ok ? "healthy" : "broken", reason };
}

function roleSort(left, right) {
  const rank = { broken: 0, warning: 1, healthy: 2 };
  return rank[left.health] - rank[right.health] || left.title.localeCompare(right.title, "ru");
}

function selectRole(roles, roleId) {
  if (!roles.length) return null;
  return roles.find((role) => role.id === roleId || role.roleKey === roleId) ?? roles[0];
}

function rolePurpose(roleId) {
  return {
    inbox: "Inbox хранит сырые входящие записи и связывает их с entity только после workflow-нормализации.",
    activity: "Activity описывает пользовательское действие, которое уже является нормализованной ролью entity.",
    focus_session: "Focus session хранит сессии фокусировки и связывает их с entity без отдельной AI-нормализации.",
  }[roleId] ?? "Роль описывает специализированные данные entity и правила связи с item_roles.";
}

function roleDataLinks(row, linkColumn, linkFk) {
  return [
    {
      table: row.payload_table,
      column: row.link_column,
      fk: linkFk ? `${row.payload_table}.${row.link_column} -> item_roles.id` : "FK не найден",
      cardinality: "payload row 0..1 -> item_roles 1",
      nullable: linkColumn?.is_nullable === "YES" ? "nullable до нормализации или soft-delete" : "non-null",
      mutationOwner: row.workflow_definition_id ? `${row.workflow_definition_id} v${row.workflow_definition_version}` : row.owner,
      createdWhen: row.workflow_definition_id ? "После успешной apply-транзакции workflow." : "При создании нормализованной role row.",
      softDelete: "payload row сохраняется; lifecycle отражается в item_roles.status/active_to_utc.",
    },
    {
      table: "item_roles",
      column: "items_id",
      fk: "item_roles.items_id -> items.id",
      cardinality: "item 1 -> item_roles 0..n",
      nullable: "non-null для нормализованной роли",
      mutationOwner: row.owner,
      createdWhen: "В момент создания роли entity.",
      softDelete: "role остается исторической строкой со статусом ended/deleted.",
    },
    {
      table: "events",
      column: "item_roles_id",
      fk: "events.item_roles_id -> item_roles.id",
      cardinality: "item_role 1 -> events 0..n",
      nullable: "nullable для raw event до нормализации",
      mutationOwner: row.workflow_definition_id ? "workflow apply transaction" : "domain event writer",
      createdWhen: "При accepted domain event или после связывания raw Inbox event.",
      softDelete: "event log не удаляется; связь остается audit trail.",
    },
  ];
}

function roleDataDiagramSource(role) {
  return [
    "flowchart TD",
    `  payload["${role.payloadTable} row"]`,
    `  roles["item_roles"]`,
    `  items["items"]`,
    `  types["item_role_types"]`,
    `  events["events"]`,
    `  payload -- "${role.payloadTable}.${role.linkColumn}" --> roles`,
    "  roles --> items",
    "  roles --> types",
    "  roles --> events",
  ].join("\n");
}

function roleLifecycleDiagramSource(role) {
  const statuses = Array.isArray(role.lifecycle.statuses) ? role.lifecycle.statuses : ["active", "ended", "deleted"];
  const lines = ["stateDiagram-v2"];
  if (role.lifecycle.raw_when) lines.push(`  [*] --> raw: ${role.lifecycle.raw_when}`);
  lines.push("  [*] --> active");
  for (const status of statuses) {
    if (status !== "active") lines.push(`  active --> ${status}`);
  }
  lines.push("  ended --> [*]");
  lines.push("  deleted --> [*]");
  return lines.join("\n");
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function listTables(db) {
  const result = await db.query(`
    SELECT table_name AS name,
      CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name ASC
  `);

  const tables = [];
  for (const table of result.rows) {
    tables.push({
      ...table,
      group: classifyTableGroup(table.name),
      description: null,
      rowCount: await countRows(db, table.name),
    });
  }
  return tables;
}

export async function readColumns(db, tableName) {
  const result = await db.query(
    `
      WITH primary_key_columns AS (
        SELECT key_column_usage.column_name
        FROM information_schema.table_constraints AS constraints
        JOIN information_schema.key_column_usage AS key_column_usage
          ON key_column_usage.constraint_name = constraints.constraint_name
         AND key_column_usage.table_schema = constraints.table_schema
         AND key_column_usage.table_name = constraints.table_name
        WHERE constraints.table_schema = current_schema()
          AND constraints.table_name = $1
          AND constraints.constraint_type = 'PRIMARY KEY'
      )
      SELECT columns.ordinal_position - 1 AS cid,
        columns.column_name AS name,
        columns.data_type AS type,
        CASE WHEN columns.is_nullable = 'NO' THEN 1 ELSE 0 END AS "isNotNull",
        columns.column_default AS dflt_value,
        CASE WHEN primary_key_columns.column_name IS NULL THEN 0 ELSE 1 END AS pk,
        0 AS hidden
      FROM information_schema.columns AS columns
      LEFT JOIN primary_key_columns
        ON primary_key_columns.column_name = columns.column_name
      WHERE columns.table_schema = current_schema()
        AND columns.table_name = $1
      ORDER BY columns.ordinal_position ASC
    `,
    [tableName],
  );
  return result.rows;
}

export async function readIndexes(db, tableName) {
  const result = await db.query(
    `
      SELECT index_class.relname AS name,
        CASE WHEN index_meta.indisunique THEN 1 ELSE 0 END AS "isUnique",
        CASE WHEN index_meta.indisprimary THEN 'pk' ELSE 'c' END AS origin,
        CASE WHEN index_meta.indpred IS NULL THEN 0 ELSE 1 END AS partial,
        COALESCE(array_agg(attribute.attname ORDER BY key.ordinality) FILTER (WHERE attribute.attname IS NOT NULL), ARRAY[]::text[]) AS columns
      FROM pg_class AS table_class
      JOIN pg_namespace AS namespace
        ON namespace.oid = table_class.relnamespace
      JOIN pg_index AS index_meta
        ON index_meta.indrelid = table_class.oid
      JOIN pg_class AS index_class
        ON index_class.oid = index_meta.indexrelid
      LEFT JOIN LATERAL unnest(index_meta.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        ON key.attnum > 0
      LEFT JOIN pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum = key.attnum
      WHERE namespace.nspname = current_schema()
        AND table_class.relname = $1
      GROUP BY index_class.relname, index_meta.indisunique, index_meta.indisprimary, index_meta.indpred
      ORDER BY index_class.relname ASC
    `,
    [tableName],
  );
  return result.rows;
}

export async function readForeignKeys(db, tableName) {
  const result = await db.query(
    `
      WITH foreign_keys AS (
        SELECT constraints.oid,
          ((row_number() OVER (ORDER BY constraints.conname)) - 1)::int AS id,
          constraints.conkey,
          constraints.confkey,
          constraints.conrelid,
          constraints.confrelid,
          constraints.confupdtype,
          constraints.confdeltype,
          constraints.confmatchtype
        FROM pg_constraint AS constraints
        JOIN pg_class AS table_class
          ON table_class.oid = constraints.conrelid
        JOIN pg_namespace AS namespace
          ON namespace.oid = table_class.relnamespace
        WHERE constraints.contype = 'f'
          AND namespace.nspname = current_schema()
          AND table_class.relname = $1
      )
      SELECT foreign_keys.id,
        (key.ordinality - 1)::int AS seq,
        target_table.relname AS "targetTable",
        source_column.attname AS "sourceColumn",
        target_column.attname AS "targetColumn",
        foreign_keys.confupdtype AS on_update,
        foreign_keys.confdeltype AS on_delete,
        foreign_keys.confmatchtype AS match
      FROM foreign_keys
      JOIN LATERAL unnest(foreign_keys.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        ON true
      JOIN pg_attribute AS source_column
        ON source_column.attrelid = foreign_keys.conrelid
       AND source_column.attnum = key.attnum
      JOIN pg_class AS target_table
        ON target_table.oid = foreign_keys.confrelid
      JOIN pg_attribute AS target_column
        ON target_column.attrelid = foreign_keys.confrelid
       AND target_column.attnum = foreign_keys.confkey[key.ordinality]
      ORDER BY foreign_keys.id ASC, seq ASC
    `,
    [tableName],
  );

  return result.rows.map((row) => ({
    ...row,
    on_update: constraintAction(row.on_update),
    on_delete: constraintAction(row.on_delete),
    match: constraintMatch(row.match),
  }));
}

export async function readTableDescriptions(db) {
  const exists = await db.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'table_descriptions'
    ) AS found
  `);
  if (!exists.rows[0]?.found) return new Map();

  const result = await db.query(`
    SELECT table_name, title, short_description, long_description
    FROM table_descriptions
    ORDER BY table_name ASC
  `);
  return new Map(result.rows.map((row) => [row.table_name, row]));
}

async function readIncomingForeignKeys(db, targetTable, tables, descriptions) {
  const incoming = [];
  for (const table of tables) {
    incoming.push(
      ...(await readForeignKeys(db, table.name))
        .filter((key) => key.targetTable === targetTable)
        .map((key) => ({
          ...key,
          sourceTable: table.name,
          sourceTitle: table.description?.title ?? titleFor(descriptions, table.name),
          targetTitle: titleFor(descriptions, key.targetTable),
        })),
    );
  }
  return incoming;
}

function describeForeignKey(key, descriptions) {
  return {
    ...key,
    targetTitle: titleFor(descriptions, key.targetTable),
  };
}

function titleFor(descriptions, tableName) {
  return descriptions.get(tableName)?.title ?? tableName;
}

function chooseTable(tables, tableName) {
  if (tableName) {
    const match = tables.find((table) => table.name === tableName);
    if (match) return match;
  }
  return tables.find((table) => table.group === "user") ?? tables[0] ?? null;
}

async function readStats(db, tables) {
  const result = await db.query(`
    SELECT current_database() AS database_name,
      current_schema() AS schema_name,
      pg_database_size(current_database())::text AS database_size_bytes
  `);
  const row = result.rows[0] ?? {};

  return {
    databaseName: row.database_name ?? "postgres",
    schemaName: row.schema_name ?? "public",
    databaseSizeBytes: Number(row.database_size_bytes ?? 0),
    tableCount: tables.length,
    totalRows: tables.reduce((sum, table) => sum + table.rowCount, 0),
  };
}

async function countRows(db, tableName) {
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(tableName)}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function readRows(db, tableName, sort, pageSize, offset) {
  const tableSql = quoteIdentifier(tableName);
  const orderSql = sort.column
    ? ` ORDER BY ${quoteIdentifier(sort.column)} IS NULL ASC, ${quoteIdentifier(sort.column)} ${sort.direction.toUpperCase()}`
    : "";
  const result = await db.query(`SELECT * FROM ${tableSql}${orderSql} LIMIT $1 OFFSET $2`, [pageSize, offset]);
  return result.rows;
}

function resolveRowSort(columns, sortDirection, tableName = "") {
  const direction = sortDirection === "asc" ? "asc" : "desc";
  const logsDtColumn = tableName === "logs" ? columns.find((column) => column.name === "dt") : null;
  const createdColumn = CREATED_COLUMN_NAMES.map((name) => columns.find((column) => column.name === name)).find(Boolean);
  const idColumn = columns.find((column) => column.name.toLowerCase() === "id" && isNumericColumn(column));
  return { column: (logsDtColumn ?? createdColumn ?? idColumn)?.name ?? null, direction };
}

function isNumericColumn(column) {
  return /^(bigint|integer|numeric|real|smallint|double precision)$/.test(String(column.type).toLowerCase());
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function constraintAction(action) {
  return (
    {
      a: "NO ACTION",
      r: "RESTRICT",
      c: "CASCADE",
      n: "SET NULL",
      d: "SET DEFAULT",
    }[action] ?? String(action ?? "")
  );
}

function constraintMatch(match) {
  return (
    {
      f: "FULL",
      p: "PARTIAL",
      s: "SIMPLE",
    }[match] ?? String(match ?? "")
  );
}
