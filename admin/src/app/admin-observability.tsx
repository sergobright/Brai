import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileKey2, Search, Workflow } from "lucide-react";
import { AutoRefresh, DiagramViewport } from "@/app/admin-observability-client";
import { Badge } from "@/shared/ui/badge";
import { ButtonLink } from "@/shared/ui/button";
import { Card, CardHeader } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";

type Diagram = { source: string; dataUrl: string | null };
type RoleHealth = "healthy" | "warning" | "broken";
type WorkflowHealth = "healthy" | "degraded" | "broken";
type RoleTab = "overview" | "relations" | "lifecycle" | "processing" | "events" | "schemas" | "diagnostics";
type WorkflowTab = "process" | "runs" | "definition";
type DiagramMode = "orchestration" | "data" | "errors";

export type RoleFilters = {
  health?: string;
  owner?: string;
  q?: string;
  role?: string;
  tab?: string;
  workflowFilter?: string;
};

export type WorkflowFilters = {
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
  hasError?: string;
  health?: string;
  mode?: string;
  owner?: string;
  q?: string;
  role?: string;
  run?: string;
  status?: string;
  stuck?: string;
  tab?: string;
  version?: string;
  workflow?: string;
};

type Role = {
  id: string;
  roleKey: string;
  title: string;
  purpose: string;
  owner: string;
  payloadTable: string;
  linkColumn: string;
  workflowDefinitionId: string;
  workflowDefinitionVersion: number | null;
  workflowTitle: string;
  workflowStatus: string;
  taskQueue: string;
  activeCount: number;
  endedCount: number;
  deletedCount: number;
  orphanPayloadRows: number;
  orphanItemRoles: number;
  lifecycle: Record<string, unknown>;
  eventRules: Record<string, unknown>;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  dataLinks: RoleDataLink[];
  diagnostics: Array<{ name: string; status: RoleHealth; reason: string }>;
  health: RoleHealth;
  healthReason: string;
  rawDefinition: Record<string, unknown>;
  diagrams: { data: Diagram; lifecycle: Diagram };
};

type RoleDataLink = {
  table: string;
  column: string;
  fk: string;
  cardinality: string;
  nullable: string;
  mutationOwner: string;
  createdWhen: string;
  softDelete: string;
};

type WorkflowSummary = {
  id: string;
  version: number;
  title: string;
  description: string;
  status: string;
  taskQueue: string;
  steps: string[];
  process: WorkflowProcess;
  inputSchemaVersion: string;
  inputSchemaJson: string;
  outputSchemaVersion: string;
  outputSchemaJson: string;
  roleContractIds: string[];
  runs24h: number;
  successRate24h: number | null;
  failed24h: number;
  p50Ms: number;
  p95Ms: number;
  activeRuns: number;
  stuckRuns: number;
  lastExecutionAt: string;
  worker: { status: string; reason: string; identity: string; buildRef: string; lastSeenAtUtc: string };
  health: WorkflowHealth;
  healthReason: string;
  diagrams?: Record<DiagramMode, Diagram>;
};

type WorkflowRun = {
  id: number;
  workflowId: string;
  runId: string;
  rawRecordId: string;
  subjectKind: string;
  subjectId: string;
  triggerKind: string;
  triggerRevision: number | null;
  watermarkFrom: number | null;
  watermarkTo: number | null;
  status: string;
  currentStep: string;
  attemptCount: number;
  lastError: string;
  startedAtUtc: string;
  completedAtUtc: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  traceStatus: string;
  durationMs: number | null;
  stuck: boolean;
  recordedSteps: number;
};

type WorkflowExecution = WorkflowRun & {
  steps: Array<Record<string, unknown>>;
  aiLogs: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  diagram?: Diagram;
};

type WorkflowProcess = {
  lanes?: Array<{ id?: string; label?: string }>;
  steps?: Array<WorkflowStep>;
  edges?: Array<{ from?: string; to?: string; kind?: string; condition?: string }>;
  terminals?: Array<{ id?: string; status?: string }>;
};

type WorkflowStep = {
  id?: string;
  label?: string;
  lane?: string;
  kind?: string;
  owner?: string;
  agent_id?: string;
  reads?: string[];
  writes?: string[];
  transaction?: string | null;
};

type JsonSchema = {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

export function RoleContractsRail({
  filters,
  summary,
}: {
  filters: RoleFilters;
  summary: { roles: Role[]; selectedRole: Role | null };
}) {
  const owners = unique(summary.roles.map((role) => role.owner));
  const filtered = filterRoles(summary.roles, filters);
  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">Контракты ролей</div>
          <div className="text-xs text-muted-foreground">{filtered.length} из {summary.roles.length}</div>
        </header>
        <form className="grid gap-2" action="/" aria-label="Фильтры ролей">
          <input name="section" type="hidden" value="role-contracts" />
          <label className="grid gap-1 text-xs text-muted-foreground">
            Поиск
            <span className="flex items-center gap-2 rounded-md border bg-background px-2">
              <Search className="size-4 shrink-0" />
              <input className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" defaultValue={filters.q ?? ""} name="q" />
            </span>
          </label>
          <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.owner ?? ""} name="owner">
            <option value="">Все owner</option>
            {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
          </select>
          <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.workflowFilter ?? ""} name="workflowFilter">
            <option value="">Workflow: все</option>
            <option value="with">Есть workflow</option>
            <option value="without">Workflow не нужен</option>
          </select>
          <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.health ?? ""} name="health">
            <option value="">Health: все</option>
            <option value="broken">broken</option>
            <option value="warning">warning</option>
            <option value="healthy">healthy</option>
          </select>
          <button className="h-10 rounded-md border bg-background px-3 text-sm font-medium" type="submit">Применить</button>
        </form>
        <ScrollArea className="-mr-3 min-h-0 pr-3" contentInset="none">
          <div className="grid gap-2">
            {filtered.map((role) => (
              <ButtonLink
                className="h-auto justify-start px-2 py-2 text-left"
                href={adminHref({ section: "role-contracts", role: role.id, tab: activeRoleTab(filters.tab) })}
                key={role.id}
                variant={summary.selectedRole?.id === role.id ? "secondary" : "ghost"}
              >
                <span className="grid min-w-0 gap-1">
                  <span className="truncate">{role.title}</span>
                  <code className="truncate text-xs text-muted-foreground">{role.id}</code>
                  <span className="text-xs text-muted-foreground">{role.payloadTable} · {role.workflowTitle || "workflow не нужен"}</span>
                </span>
                <HealthBadge health={role.health} />
              </ButtonLink>
            ))}
            {filtered.length === 0 ? <p className="m-0 text-sm text-muted-foreground">Под выбранные фильтры ролей нет.</p> : null}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}

export function RoleContractsWorkspace({
  filters,
  summary,
}: {
  filters: RoleFilters;
  summary: { roles: Role[]; selectedRole: Role | null };
}) {
  const role = summary.selectedRole;
  const tab = activeRoleTab(filters.tab);
  if (!role) return <EmptyState text="Контракты ролей не найдены. Проверьте миграции role_contracts и item_role_types." />;
  return (
    <div className="grid min-w-0 gap-3.5 pb-6">
      <ObjectHeader
        badges={[role.owner, role.payloadTable, role.workflowTitle ? `${role.workflowDefinitionId} v${role.workflowDefinitionVersion}` : "workflow не нужен"]}
        health={role.health}
        icon={<FileKey2 className="size-4" />}
        id={role.id}
        metrics={[
          ["active", role.activeCount],
          ["ended", role.endedCount],
          ["deleted", role.deletedCount],
          ["orphan", role.orphanPayloadRows + role.orphanItemRoles],
        ]}
        subtitle={role.purpose}
        title={role.title}
        healthReason={role.healthReason}
      />
      <TabNav
        tabs={[
          ["overview", "Обзор"],
          ["relations", "Связи данных"],
          ["lifecycle", "Lifecycle"],
          ["processing", "Обработка"],
          ["events", "События"],
          ["schemas", "Schemas"],
          ["diagnostics", "Диагностика"],
        ]}
        active={tab}
        href={(next) => adminHref({ section: "role-contracts", role: role.id, tab: next })}
      />
      {tab === "overview" ? <RoleOverview role={role} /> : null}
      {tab === "relations" ? <RoleRelations role={role} /> : null}
      {tab === "lifecycle" ? <RoleLifecycle role={role} /> : null}
      {tab === "processing" ? <RoleProcessing role={role} /> : null}
      {tab === "events" ? <RoleEvents role={role} /> : null}
      {tab === "schemas" ? <SchemaTables inputSchema={role.inputSchema} inputVersion={role.inputSchemaVersion} outputSchema={role.outputSchema} outputVersion={role.outputSchemaVersion} /> : null}
      {tab === "diagnostics" ? <RoleDiagnostics role={role} /> : null}
    </div>
  );
}

export function WorkflowsRail({
  filters,
  summary,
}: {
  filters: WorkflowFilters;
  summary: { workflows: WorkflowSummary[]; selectedWorkflow: WorkflowSummary | null };
}) {
  const filtered = filterWorkflows(summary.workflows, filters);
  const roles = unique(summary.workflows.flatMap((workflow) => workflow.roleContractIds));
  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">Workflow</div>
          <div className="text-xs text-muted-foreground">{filtered.length} из {summary.workflows.length}</div>
        </header>
        <form className="grid gap-2" action="/" aria-label="Фильтры workflow">
          <input name="section" type="hidden" value="workflows" />
          <label className="grid gap-1 text-xs text-muted-foreground">
            Поиск
            <span className="flex items-center gap-2 rounded-md border bg-background px-2">
              <Search className="size-4 shrink-0" />
              <input className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" defaultValue={filters.q ?? ""} name="q" />
            </span>
          </label>
          <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.health ?? ""} name="health">
            <option value="">Health: все</option>
            <option value="healthy">healthy</option>
            <option value="degraded">degraded</option>
            <option value="broken">broken</option>
          </select>
          <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.status ?? ""} name="status">
            <option value="">Runs: все</option>
            <option value="running">running</option>
            <option value="failed">failed</option>
            <option value="needs_review">needs_review</option>
            <option value="completed">completed</option>
          </select>
          <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.role ?? ""} name="role">
            <option value="">Role: все</option>
            {roles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
          <button className="h-10 rounded-md border bg-background px-3 text-sm font-medium" type="submit">Применить</button>
        </form>
        <ScrollArea className="-mr-3 min-h-0 pr-3" contentInset="none">
          <div className="grid gap-2">
            {filtered.map((workflow) => (
              <ButtonLink
                className="h-auto justify-start px-2 py-2 text-left"
                href={adminHref({ section: "workflows", workflow: workflow.id, version: workflow.version, tab: activeWorkflowTab(filters.tab) })}
                key={`${workflow.id}:${workflow.version}`}
                variant={summary.selectedWorkflow?.id === workflow.id && summary.selectedWorkflow.version === workflow.version ? "secondary" : "ghost"}
              >
                <span className="grid min-w-0 gap-1">
                  <span className="truncate">{workflow.title}</span>
                  <code className="truncate text-xs text-muted-foreground">{workflow.id} v{workflow.version}</code>
                  <span className="text-xs text-muted-foreground">{workflow.runs24h} runs · p95 {duration(workflow.p95Ms)}</span>
                </span>
                <HealthBadge health={workflow.health} />
              </ButtonLink>
            ))}
            {filtered.length === 0 ? <p className="m-0 text-sm text-muted-foreground">Под выбранные фильтры workflow нет.</p> : null}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}

export function WorkflowsWorkspace({
  filters,
  summary,
}: {
  filters: WorkflowFilters;
  summary: {
    workflows: WorkflowSummary[];
    selectedWorkflow: WorkflowSummary | null;
    runs: { rows: WorkflowRun[]; nextCursor: string | null; pageSize: number };
    selectedExecution: WorkflowExecution | null;
  };
}) {
  const workflow = summary.selectedWorkflow;
  const tab = activeWorkflowTab(filters.tab);
  if (!workflow) return <EmptyState text="Workflow definitions не найдены. Проверьте миграции workflow_definitions." />;
  const hasActiveRun = summary.runs.rows.some((run) => ["queued", "running"].includes(run.status));
  return (
    <div className="grid min-w-0 gap-3.5 pb-6">
      <AutoRefresh enabled={tab === "runs" && hasActiveRun} intervalMs={2_000} />
      <ObjectHeader
        badges={[workflow.status, workflow.taskQueue, workflow.roleContractIds.join(", ") || "roles не связаны"]}
        health={workflow.health}
        icon={<Workflow className="size-4" />}
        id={`${workflow.id} v${workflow.version}`}
        metrics={[
          ["runs 24h", workflow.runs24h],
          ["success", workflow.successRate24h == null ? "нет данных" : `${Math.round(workflow.successRate24h * 100)}%`],
          ["p50", duration(workflow.p50Ms)],
          ["p95", duration(workflow.p95Ms)],
          ["running", workflow.activeRuns],
          ["stuck", workflow.stuckRuns],
        ]}
        subtitle={workflow.description}
        title={workflow.title}
        healthReason={`${workflow.healthReason} Worker: ${workflow.worker.status} (${workflow.worker.reason})`}
      />
      <TabNav
        tabs={[
          ["process", "Процесс"],
          ["runs", "Запуски"],
          ["definition", "Определение"],
        ]}
        active={tab}
        href={(next) => adminHref({ section: "workflows", workflow: workflow.id, version: workflow.version, tab: next })}
      />
      {tab === "process" ? <WorkflowProcessView filters={filters} workflow={workflow} /> : null}
      {tab === "runs" ? <WorkflowRuns filters={filters} summary={summary} workflow={workflow} /> : null}
      {tab === "definition" ? <WorkflowDefinition workflows={summary.workflows} workflow={workflow} /> : null}
    </div>
  );
}

function ObjectHeader({
  badges,
  health,
  healthReason,
  icon,
  id,
  metrics,
  subtitle,
  title,
}: {
  badges: string[];
  health: string;
  healthReason: string;
  icon: ReactNode;
  id: string;
  metrics: Array<[string, string | number]>;
  subtitle: string;
  title: string;
}) {
  return (
    <Card>
      <CardHeader className="gap-3 p-4 md:p-5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">{icon}<code className="min-w-0 break-all">{id}</code></div>
        <div className="grid gap-2">
          <h1 className="m-0 break-words text-2xl font-semibold leading-tight">{title}</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <HealthBadge health={health} />
          {badges.filter(Boolean).map((badge) => <Badge key={badge} variant="outline">{badge}</Badge>)}
        </div>
        <p className="m-0 text-sm leading-6 text-muted-foreground">{healthReason}</p>
        <dl className="m-0 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
          {metrics.map(([label, value]) => (
            <div className="rounded-lg border bg-background p-3" key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="m-0 mt-1 text-base font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      </CardHeader>
    </Card>
  );
}

function RoleOverview({ role }: { role: Role }) {
  const rows: Array<[string, string]> = [
    ["Для чего существует", role.purpose],
    ["Кто создаёт", role.workflowTitle ? `Workflow ${role.workflowDefinitionId} v${role.workflowDefinitionVersion}` : `${role.owner}; роль создаётся без AI workflow.`],
    ["Source of truth", `${role.payloadTable} хранит role-specific данные; item_roles хранит lifecycle и связь с items.`],
    ["Инварианты", `${role.payloadTable}.${role.linkColumn} ссылается на item_roles.id; active роль не должна иметь orphan-связь.`],
    ["Raw", role.lifecycle.raw_when ? String(role.lifecycle.raw_when) : "Raw-состояние отсутствует: роль создаётся уже связанной с item_roles."],
    ["Active", "item_roles.status = active и active_to_utc пустой."],
    ["Ended", "item_roles.status = ended: роль завершена, но остается в истории."],
    ["Deleted", "item_roles.status = deleted: soft-delete фиксируется lifecycle-статусом, audit trail сохраняется."],
    ["Почему workflow нужна или не нужна", role.workflowTitle ? "Workflow нужен, потому что raw payload должен пройти нормализацию и schema validation перед domain apply." : "Workflow не нужен: данные создаются уже структурированными внутри основного доменного потока."],
  ];
  return <KeyValueTable rows={rows} title="Обзор роли" />;
}

function RoleRelations({ role }: { role: Role }) {
  return (
    <div className="grid gap-3.5">
      <DiagramViewport alt={`Связи данных ${role.title}`} dataUrl={role.diagrams.data.dataUrl} source={role.diagrams.data.source} summary="payload row связывается с item_roles, items, item_role_types и events." title="Связи данных" />
      <SimpleTable
        columns={["Таблица", "Колонка", "FK", "Cardinality", "Nullable", "Owner", "Создание", "Soft-delete"]}
        rows={role.dataLinks.map((link) => [link.table, link.column, link.fk, link.cardinality, link.nullable, link.mutationOwner, link.createdWhen, link.softDelete])}
      />
    </div>
  );
}

function RoleLifecycle({ role }: { role: Role }) {
  const statuses = Array.isArray(role.lifecycle.statuses) ? role.lifecycle.statuses.map(String) : ["active", "ended", "deleted"];
  return (
    <div className="grid gap-3.5">
      <DiagramViewport alt={`Lifecycle ${role.title}`} dataUrl={role.diagrams.lifecycle.dataUrl} source={role.diagrams.lifecycle.source} summary="Диаграмма состояний роли и terminal statuses." title="Lifecycle" />
      <SimpleTable
        columns={["Переход", "Инициатор", "Условие", "Событие", "Terminal"]}
        rows={statuses.map((status) => [
          status === "active" ? "[*] -> active" : `active -> ${status}`,
          role.workflowTitle || role.owner,
          status === "active" ? "роль создана и связана с item_roles" : `доменный поток выставляет ${status}`,
          status === "active" ? "create/normalized" : status,
          status === "active" ? "non-terminal" : "terminal",
        ])}
      />
    </div>
  );
}

function RoleProcessing({ role }: { role: Role }) {
  const rows: Array<[string, string]> = role.workflowTitle ? [
    ["Raw role condition", role.lifecycle.raw_when ? String(role.lifecycle.raw_when) : "Raw-состояние не задано в lifecycle_json."],
    ["Workflow", `${role.workflowDefinitionId} v${role.workflowDefinitionVersion}`],
    ["Task queue", role.taskQueue],
    ["Agents", role.id === "inbox" ? "inbox.image_describer optional; inbox.normalizer через локальный /srv/opt/codex-cli/bin/codex. Groq здесь не используется." : "Агенты определяются workflow definition."],
    ["Retry/timeout", "Normalizer делает bounded attempts; Codex timeout становится failed/needs_review без частичного apply."],
    ["Apply transaction", "items, item_roles, payload link, event link, normalized event и execution status обновляются атомарно."],
    ["Idempotency", "Повторный apply сверяет existing normalized event и item_roles_id."],
    ["Schema validation failure", "Invalid strict-schema result пишет failed AI attempt и повторяет raw_normalizer, пока есть attempts."],
    ["Attempts exhausted", "Execution становится needs_review, raw payload сохраняется."],
  ] : [
    ["Workflow", "Workflow не нужен: payload создаётся уже структурированным."],
    ["Apply owner", role.owner],
    ["Idempotency", "Идемпотентность обеспечивается доменным writer и event ledger."],
  ];
  return <KeyValueTable rows={rows} title="Обработка" />;
}

function RoleEvents({ role }: { role: Role }) {
  return (
    <SimpleTable
      columns={["Event type", "Название", "Actor", "Условие", "Payload schema", "Связь", "Lifecycle"]}
      rows={roleEvents(role)}
    />
  );
}

function RoleDiagnostics({ role }: { role: Role }) {
  return (
    <div className="grid gap-3.5">
      <SimpleTable columns={["Проверка", "Статус", "Причина"]} rows={role.diagnostics.map((item) => [item.name, item.status, item.reason])} />
      <details className="rounded-lg border bg-muted/20 p-4">
        <summary className="cursor-pointer text-sm font-medium">Техническое определение</summary>
        <pre className="mb-0 mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(role.rawDefinition, null, 2)}</pre>
      </details>
    </div>
  );
}

function WorkflowProcessView({ filters, workflow }: { filters: WorkflowFilters; workflow: WorkflowSummary }) {
  const mode = activeDiagramMode(filters.mode);
  const diagram = workflow.diagrams?.[mode];
  return (
    <div className="grid gap-3.5">
      <TabNav
        tabs={[
          ["orchestration", "Оркестрация"],
          ["data", "Данные"],
          ["errors", "Ошибки и retry"],
        ]}
        active={mode}
        href={(next) => adminHref({ section: "workflows", workflow: workflow.id, version: workflow.version, tab: "process", mode: next })}
      />
      <DiagramViewport
        alt={`${workflow.title}: ${mode}`}
        dataUrl={diagram?.dataUrl ?? null}
        source={diagram?.source ?? ""}
        steps={(workflow.process.steps ?? []) as unknown as Array<Record<string, unknown>>}
        summary="Диаграмма сгенерирована из одного process_json."
        title={mode === "orchestration" ? "Оркестрация" : mode === "data" ? "Данные" : "Ошибки и retry"}
      />
    </div>
  );
}

function WorkflowRuns({
  filters,
  summary,
  workflow,
}: {
  filters: WorkflowFilters;
  summary: { runs: { rows: WorkflowRun[]; nextCursor: string | null }; selectedExecution: WorkflowExecution | null };
  workflow: WorkflowSummary;
}) {
  const selected = summary.selectedExecution;
  return (
    <div className="grid gap-3.5">
      <form className="flex flex-wrap gap-2" action="/" aria-label="Фильтры запусков">
        <input name="section" type="hidden" value="workflows" />
        <input name="workflow" type="hidden" value={workflow.id} />
        <input name="version" type="hidden" value={workflow.version} />
        <input name="tab" type="hidden" value="runs" />
        <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={filters.status ?? ""} name="status">
          <option value="">Status: все</option>
          {["queued", "running", "completed", "failed", "needs_review"].map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <label className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm">
          <input defaultChecked={filters.stuck === "1"} name="stuck" type="checkbox" value="1" />
          stuck
        </label>
        <label className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm">
          <input defaultChecked={filters.hasError === "1"} name="hasError" type="checkbox" value="1" />
          has error
        </label>
        <button className="h-10 rounded-md border bg-background px-3 text-sm font-medium" type="submit">Применить</button>
      </form>
      <WorkflowRunsTable filters={filters} runs={summary.runs.rows} workflow={workflow} />
      {summary.runs.nextCursor ? (
        <ButtonLink href={adminHref({ section: "workflows", workflow: workflow.id, version: workflow.version, tab: "runs", cursor: summary.runs.nextCursor })} variant="outline">
          Следующие 50
        </ButtonLink>
      ) : null}
      {selected ? <ExecutionDetail execution={selected} /> : <EmptyState text="У этой workflow пока нет запусков." />}
    </div>
  );
}

function WorkflowRunsTable({ filters, runs, workflow }: { filters: WorkflowFilters; runs: WorkflowRun[]; workflow: WorkflowSummary }) {
  return (
    <SimpleTable
      columns={["Status", "Subject", "Trigger", "Created", "Started", "Completed", "Duration", "Current step", "Attempt", "Last progress", "Workflow ID", "Run ID", "Trace", "Stuck", "Error"]}
      rows={runs.map((run) => [
        linkCell(run.status, adminHref({ section: "workflows", workflow: workflow.id, version: workflow.version, tab: "runs", run: run.runId, status: filters.status })),
        `${run.subjectKind}:${run.subjectId}`,
        run.triggerKind ? `${run.triggerKind}:${run.triggerRevision ?? ""}` : "",
        run.createdAtUtc,
        run.startedAtUtc,
        run.completedAtUtc,
        duration(run.durationMs),
        run.currentStep,
        run.attemptCount,
        run.updatedAtUtc,
        run.workflowId,
        run.runId || "без run_id",
        run.traceStatus,
        run.stuck ? "stuck" : "нет",
        run.lastError,
      ])}
      empty="Запусков по выбранным фильтрам нет."
    />
  );
}

function ExecutionDetail({ execution }: { execution: WorkflowExecution }) {
  const terminal = ["completed", "failed", "needs_review"].includes(execution.status);
  return (
    <section className="grid gap-3.5" aria-label="Детали execution">
      <AutoRefresh enabled={!terminal} intervalMs={terminal ? 10_000 : 2_000} />
      <Card>
        <CardHeader className="gap-2 p-4">
          <div className="flex flex-wrap gap-2">
            <Badge>{execution.status}</Badge>
            <Badge variant="outline">trace {execution.traceStatus}</Badge>
            {execution.stuck ? <Badge variant="destructive">stuck</Badge> : null}
          </div>
          <h2 className="m-0 break-all text-lg font-semibold">{execution.workflowId}</h2>
          <p className="m-0 text-sm text-muted-foreground">
            run <code>{execution.runId || "без run_id"}</code> · subject <code>{execution.subjectKind || "unknown"}:{execution.subjectId || "не задан"}</code>
            {execution.triggerKind ? <> · trigger <code>{execution.triggerKind}:{execution.triggerRevision ?? ""}</code></> : null}
            {execution.watermarkFrom != null ? <> · watermark <code>{execution.watermarkFrom}..{execution.watermarkTo ?? ""}</code></> : null}
          </p>
          {execution.traceStatus === "unavailable" ? <p className="m-0 text-sm text-muted-foreground">Детальный trace недоступен для запусков до версии телеметрии.</p> : null}
          {execution.traceStatus === "partial" ? <p className="m-0 text-sm text-destructive">Trace частичный: часть telemetry steps не записалась или была потеряна.</p> : null}
        </CardHeader>
      </Card>
      {execution.diagram ? (
        <DiagramViewport
          alt={`Actual path ${execution.workflowId}`}
          dataUrl={execution.diagram.dataUrl}
          source={execution.diagram.source}
          steps={execution.steps}
          summary="Фактический путь подсвечен статусами записанных steps."
          title="Actual path"
        />
      ) : null}
      <SimpleTable
        columns={["Step", "Attempt", "Status", "Start", "End", "Duration", "Agent", "AI log", "Retry/skip/error"]}
        rows={execution.steps.map((step) => [
          String(step.step_key ?? ""),
          String(step.attempt ?? ""),
          String(step.status ?? ""),
          String(step.started_at_utc ?? ""),
          String(step.completed_at_utc ?? ""),
          duration(Number(step.duration_ms ?? 0)),
          String(step.agent_id ?? ""),
          String(step.ai_log_id ?? ""),
          String(step.error_summary ?? step.error_code ?? ""),
        ])}
        empty={execution.traceStatus === "unavailable" ? "Legacy execution без новой telemetry." : "Steps пока не записаны."}
      />
      <SimpleTable
        columns={["AI log", "Agent", "Version", "Status", "Attempt", "Time"]}
        rows={execution.aiLogs.map((log) => [String(log.id ?? ""), String(log.agent_id ?? ""), String(log.agent_version ?? ""), String(log.status ?? ""), String(log.attempt_number ?? ""), String(log.dt ?? "")])}
        empty="AI logs для этого run не найдены."
      />
      <SimpleTable
        columns={["Entity", "Event/action", "Status", "Time", "Role link"]}
        rows={execution.events.map((event) => [String(event.id ?? ""), `${String(event.event_type ?? "")} / ${String(event.event_action ?? "")}`, String(event.status ?? ""), String(event.occurred_at_utc ?? ""), String(event.item_roles_id ?? "")])}
        empty="Связанные events не найдены."
      />
      <SimpleTable
        columns={["Runtime log", "Operation", "Status", "Reason", "Time"]}
        rows={execution.logs.map((log) => [String(log.id ?? ""), String(log.operation ?? ""), String(log.status ?? ""), String(log.reason ?? ""), String(log.dt ?? "")])}
        empty="Связанные bounded runtime logs не найдены."
      />
    </section>
  );
}

function WorkflowDefinition({ workflows, workflow }: { workflows: WorkflowSummary[]; workflow: WorkflowSummary }) {
  const versions = workflows.filter((item) => item.id === workflow.id).sort((a, b) => b.version - a.version);
  return (
    <div className="grid gap-3.5">
      <SimpleTable columns={["Version", "Status", "Task queue", "Updated", "Roles"]} rows={versions.map((item) => [item.version, item.status, item.taskQueue, item.lastExecutionAt || item.worker.lastSeenAtUtc || "", item.roleContractIds.join(", ")])} />
      <SimpleTable
        columns={["Step", "Lane", "Kind", "Owner", "Agent", "Reads", "Writes", "Transaction"]}
        rows={(workflow.process.steps ?? []).map((step) => [step.id ?? "", step.lane ?? "", step.kind ?? "", step.owner ?? "", step.agent_id ?? "", (step.reads ?? []).join(", "), (step.writes ?? []).join(", "), step.transaction ?? ""])}
      />
      <SimpleTable
        columns={["From", "To", "Kind", "Condition"]}
        rows={(workflow.process.edges ?? []).map((edge) => [edge.from ?? "", edge.to ?? "", edge.kind ?? "", edge.condition ?? ""])}
      />
      <SchemaTables inputSchema={parseSchema(workflow.inputSchemaJson)} inputVersion={workflow.inputSchemaVersion} outputSchema={parseSchema(workflow.outputSchemaJson)} outputVersion={workflow.outputSchemaVersion} />
      <details className="rounded-lg border bg-muted/20 p-4">
        <summary className="cursor-pointer text-sm font-medium">Structured process_json и legacy Mermaid source</summary>
        <pre className="mb-0 mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(workflow.process, null, 2)}</pre>
      </details>
    </div>
  );
}

function SchemaTables({ inputSchema, inputVersion, outputSchema, outputVersion }: { inputSchema: JsonSchema; inputVersion: string; outputSchema: JsonSchema; outputVersion: string }) {
  return (
    <div className="grid gap-3.5 xl:grid-cols-2">
      <SchemaTable schema={inputSchema} title={`Input schema ${inputVersion || "не требуется"}`} version={inputVersion} />
      <SchemaTable schema={outputSchema} title={`Output schema ${outputVersion || "не требуется"}`} version={outputVersion} />
    </div>
  );
}

function SchemaTable({ schema, title, version }: { schema: JsonSchema; title: string; version: string }) {
  return (
    <section className="grid gap-2">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      <SimpleTable
        columns={["Field", "Type", "Required", "Nullable", "Constraints", "Description", "Example", "Schema version"]}
        rows={schemaFields(schema).map((field) => [field.name, field.type, field.required ? "yes" : "no", field.nullable ? "yes" : "no", field.constraints, field.description, field.example, version])}
        empty="Schema не требуется или не задана для этой роли."
      />
    </section>
  );
}

function KeyValueTable({ rows, title }: { rows: Array<[string, string]>; title: string }) {
  return (
    <section className="grid gap-2">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <SimpleTable columns={["Вопрос", "Ответ"]} rows={rows} />
    </section>
  );
}

function SimpleTable({
  columns,
  empty = "Данных нет.",
  rows,
}: {
  columns: string[];
  empty?: string;
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <Table className="text-xs" variant="card">
      <TableHeader>
        <TableRow>{columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.length ? rows.map((row, index) => (
          <TableRow key={index}>
            {row.map((cell, cellIndex) => (
              <TableCell className="max-w-[28rem] !whitespace-normal !leading-5 [overflow-wrap:anywhere]" key={cellIndex}>{cell}</TableCell>
            ))}
          </TableRow>
        )) : (
          <TableRow><TableCell className="text-muted-foreground" colSpan={columns.length}>{empty}</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function TabNav<T extends string>({
  active,
  href,
  tabs,
}: {
  active: T;
  href: (tab: T) => string;
  tabs: Array<[T, string]>;
}) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Вкладки">
      {tabs.map(([id, label]) => (
        <ButtonLink aria-current={active === id ? "page" : undefined} href={href(id)} key={id} variant={active === id ? "default" : "outline"}>
          {label}
        </ButtonLink>
      ))}
    </nav>
  );
}

function HealthBadge({ health }: { health: string }) {
  const icon = health === "healthy" ? <CheckCircle2 className="size-3" /> : health === "broken" ? <AlertTriangle className="size-3" /> : <Clock className="size-3" />;
  return <Badge variant={health === "broken" ? "destructive" : health === "healthy" ? "default" : "outline"}>{icon}{health}</Badge>;
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card className="p-4">
      <p className="m-0 text-sm text-muted-foreground">{text}</p>
    </Card>
  );
}

function roleEvents(role: Role) {
  if (role.id === "inbox") {
    return [
      ["create", "Raw Inbox создан", "user/api", "Принят raw payload", "inbox create payload v1", "events.subject_id -> inbox.id; item_roles_id появляется после apply", "raw -> active"],
      ["normalized", "Inbox нормализован", "inbox.normalizer", "Apply transaction committed", "brai.inbox.normalized-event.v1", "events.items_id/items and item_roles_id link execution result", "active"],
    ];
  }
  return [
    ["create", `${role.title} создана`, role.owner, "Доменный writer создал payload и item_role", "domain event payload", "events.item_roles_id -> item_roles.id", "active"],
    ["ended/deleted", `${role.title} завершена или удалена`, role.owner, "Lifecycle transition выполнен", "domain event payload", "events.item_roles_id -> item_roles.id", "terminal"],
  ];
}

function schemaFields(schema: JsonSchema) {
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  return Object.entries(properties).map(([name, rule]) => ({
    name,
    type: String(rule.type ?? ""),
    required: required.has(name),
    nullable: Array.isArray(rule.type) ? rule.type.includes("null") : false,
    constraints: ["minLength", "maxLength", "pattern", "additionalProperties"].map((key) => rule[key] === undefined ? "" : `${key}: ${String(rule[key])}`).filter(Boolean).join("; "),
    description: String(rule.description ?? ""),
    example: rule.example === undefined ? "" : String(rule.example),
  }));
}

function parseSchema(value: string): JsonSchema {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonSchema : {};
  } catch {
    return {};
  }
}

function filterRoles(roles: Role[], filters: RoleFilters) {
  const query = (filters.q ?? "").toLowerCase();
  return roles.filter((role) => {
    if (filters.owner && role.owner !== filters.owner) return false;
    if (filters.health && role.health !== filters.health) return false;
    if (filters.workflowFilter === "with" && !role.workflowDefinitionId) return false;
    if (filters.workflowFilter === "without" && role.workflowDefinitionId) return false;
    if (!query) return true;
    return [role.title, role.id, role.roleKey, role.payloadTable, role.workflowDefinitionId, role.workflowTitle].join(" ").toLowerCase().includes(query);
  });
}

function filterWorkflows(workflows: WorkflowSummary[], filters: WorkflowFilters) {
  const query = (filters.q ?? "").toLowerCase();
  return workflows.filter((workflow) => {
    if (filters.health && workflow.health !== filters.health) return false;
    if (filters.role && !workflow.roleContractIds.includes(filters.role)) return false;
    if (!query) return true;
    return [workflow.title, workflow.id, workflow.taskQueue, workflow.roleContractIds.join(" ")].join(" ").toLowerCase().includes(query);
  });
}

function activeRoleTab(value: string | undefined): RoleTab {
  return value === "relations" || value === "lifecycle" || value === "processing" || value === "events" || value === "schemas" || value === "diagnostics" ? value : "overview";
}

function activeWorkflowTab(value: string | undefined): WorkflowTab {
  return value === "runs" || value === "definition" ? value : "process";
}

function activeDiagramMode(value: string | undefined): DiagramMode {
  return value === "data" || value === "errors" ? value : "orchestration";
}

function adminHref(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return `/?${search.toString()}`;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, "ru"));
}

function duration(ms: number | null) {
  if (!ms) return "нет данных";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}

function linkCell(label: string, href: string) {
  return <Link className="text-primary underline-offset-2 hover:underline" href={href}>{label}</Link>;
}
