import type { ReactNode } from "react";
import { Network, ShieldCheck } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { ButtonLink } from "@/shared/ui/button";
import { Card, CardHeader } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import type { ContextObservabilitySummary, ContextRow } from "@/lib/contextObservability";

export type ContextFilters = { tab?: string; relationPage?: string };
type ContextTab = "contracts" | "relations" | "decisions" | "policies" | "operations" | "agents" | "diagnostics";

const TABS: Array<[ContextTab, string]> = [
  ["contracts", "Контракты"],
  ["relations", "Relations"],
  ["decisions", "Решения"],
  ["policies", "Политики и audits"],
  ["operations", "Операции"],
  ["agents", "Agents и workflows"],
  ["diagnostics", "Диагностика"],
];

export function ContextObservabilityRail({
  filters,
  summary,
}: {
  filters: ContextFilters;
  summary: ContextObservabilitySummary;
}) {
  const active = activeTab(filters.tab);
  const metrics = [
    ["Типы Relations", summary.relationTypes.length],
    ["Relations на странице", summary.relations.length],
    ["Решения", summary.decisions.length],
    ["Политики", summary.policies.length],
    ["Agents", summary.agents.length],
  ];
  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">Context graph</div>
          <div className="text-xs text-muted-foreground">Read-only · максимум {summary.limit} строк на набор</div>
        </header>
        <dl className="m-0 grid grid-cols-2 gap-2">
          {metrics.map(([label, count]) => (
            <div className="rounded-lg border bg-background p-2" key={label}>
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="m-0 mt-1 text-sm font-semibold">{count}</dd>
            </div>
          ))}
        </dl>
        <ScrollArea className="-mr-3 min-h-0 pr-3" contentInset="none">
          <nav className="grid gap-1" aria-label="Context observability">
            {TABS.map(([id, label]) => (
              <ButtonLink
                aria-current={active === id ? "page" : undefined}
                className="justify-start"
                href={contextHref(id)}
                key={id}
                variant={active === id ? "secondary" : "ghost"}
              >
                {label}
              </ButtonLink>
            ))}
          </nav>
        </ScrollArea>
      </div>
    </aside>
  );
}

export function ContextObservabilityWorkspace({
  filters,
  summary,
}: {
  filters: ContextFilters;
  summary: ContextObservabilitySummary;
}) {
  const tab = activeTab(filters.tab);
  return (
    <div className="grid min-w-0 gap-3.5 pb-6">
      <Card>
        <CardHeader className="gap-3 p-4 md:p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Network className="size-4" />Relations · Goals · Context decisions</div>
          <h1 className="m-0 text-2xl font-semibold leading-tight">Контекст и агентная автоматика</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">
            Канонические Relations, история решений, calibration policies, audits и пять изолированных agent workflows. Экран ничего не изменяет в Postgres.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">read-only</Badge>
            <Badge variant="outline">bounded {summary.limit}</Badge>
            <Badge variant="outline">без raw prompts/output</Badge>
          </div>
        </CardHeader>
      </Card>
      <nav className="flex flex-wrap gap-2" aria-label="Разделы context observability">
        {TABS.map(([id, label]) => (
          <ButtonLink href={contextHref(id)} key={id} variant={tab === id ? "default" : "outline"}>{label}</ButtonLink>
        ))}
      </nav>
      {tab === "contracts" ? <ContractsView summary={summary} /> : null}
      {tab === "relations" ? <RelationsView summary={summary} /> : null}
      {tab === "decisions" ? <DecisionsView summary={summary} /> : null}
      {tab === "policies" ? <PoliciesView summary={summary} /> : null}
      {tab === "operations" ? <OperationsView summary={summary} /> : null}
      {tab === "agents" ? <AgentsView summary={summary} /> : null}
      {tab === "diagnostics" ? <DiagnosticsView summary={summary} /> : null}
    </div>
  );
}

function ContractsView({ summary }: { summary: ContextObservabilitySummary }) {
  return (
    <Section title="Relation contracts" description="Directionality, lifecycle, ordering и допустимые role/type endpoints.">
      <DataTable
        columns={["ID / key", "Title", "Direction", "Labels", "Ordered", "Status", "Scope", "Rules", "Facts", "Updated"]}
        rows={summary.relationTypes.map((row) => [
          `${text(row.id)} / ${text(row.key)}`,
          text(row.title),
          text(row.directionality),
          `${text(row.source_label)} → ${text(row.target_label)}`,
          yesNo(row.is_ordered),
          text(row.status),
          yesNo(row.is_system) === "да" ? "system" : text(row.user_id),
          rules(row.rules),
          `${number(row.active_count)} active / ${number(row.relation_count)} total`,
          text(row.updated_at_utc),
        ])}
      />
    </Section>
  );
}

function RelationsView({ summary }: { summary: ContextObservabilitySummary }) {
  const pagination = summary.relationPagination;
  return (
    <div className="grid gap-3.5">
      <Section title="Relation facts and history" description="Полная постраничная история интервалов: direction, lifecycle, actor, decision/operation provenance и вычисленная validity.">
        <DataTable
          columns={["Relation", "Type / direction", "Source", "Target", "Status", "Position", "Interval", "Created actor", "Ended actor / reason", "Operations", "Decision", "Validity"]}
          rows={summary.relations.map((row) => [
            code(row.id),
            `${text(row.relation_type_key)} / ${text(row.directionality)}`,
            item(row.source_items_id, row.source_title),
            item(row.target_items_id, row.target_title),
            text(row.status),
            text(row.position),
            `${text(row.active_from_utc)} → ${text(row.active_to_utc)}`,
            item(row.created_by_actor_id, row.created_by_actor_type),
            [item(row.ended_by_actor_id, row.ended_by_actor_type), text(row.end_reason)].filter(Boolean).join(" · "),
            [text(row.operation_id), text(row.ended_operation_id)].filter(Boolean).join(" → "),
            text(row.origin_decision_id),
            list(row.diagnostics) || "valid",
          ])}
        />
        <div className="flex items-center justify-end gap-2">
          {pagination.hasPrevious ? <ButtonLink href={contextHref("relations", pagination.page - 1)} size="sm" variant="outline">Назад</ButtonLink> : null}
          <span className="text-xs text-muted-foreground">Страница {pagination.page}</span>
          {pagination.hasNext ? <ButtonLink href={contextHref("relations", pagination.page + 1)} size="sm" variant="outline">Дальше</ButtonLink> : null}
        </div>
      </Section>
      <Section title="Relation event ledger" description="Последние bounded accepted/ignored Relation events без payload_json.">
        <DataTable columns={["Event", "Type / action", "Status", "Subject", "Actor", "Time", "Reason", "Trace"]} rows={summary.relationEvents.map((row) => [code(row.event_id || row.id), `${text(row.event_type)} / ${text(row.event_action)}`, text(row.status), `${text(row.subject_type)}:${text(row.subject_id)}`, `${text(row.actor_type)}:${text(row.actor_id)}`, text(row.occurred_at_utc), text(row.ignore_reason), text(row.trace_id)])} />
      </Section>
    </div>
  );
}

function DecisionsView({ summary }: { summary: ContextObservabilitySummary }) {
  return (
    <div className="grid gap-3.5">
      <Section title="Context decisions" description="Bounded rationale, evidence и structured proposal; без raw prompt/model output и неограниченного пользовательского контента.">
        <DataTable
          columns={["Decision", "Agent / versions", "Kind / subject", "Confidence / rationale", "Evidence", "Proposal", "Policy at evaluation", "Resolution", "Workflow / attempt", "Apply operation", "Compensation", "Relation", "Created"]}
          rows={summary.decisions.map((row) => [
            code(row.id),
            `${text(row.agent_id)} ${text(row.agent_version)} · prompt ${text(row.prompt_version)} · schema ${text(row.schema_version)} · ${text(row.model)}`,
            `${text(row.decision_kind)} · ${text(row.trigger_items_id)} @ revision ${text(row.trigger_revision)}`,
            `${percent(row.confidence)} · ${excerpt(row.rationale_excerpt, row.rationale_truncated)}`,
            payloadDetails(`${number(row.evidence_count)} evidence`, row.evidence_excerpt, row.evidence_truncated),
            payloadDetails(`Ключи: ${list(row.proposal_keys)}`, row.proposal_excerpt, row.proposal_truncated),
            `${text(row.policies_id)} · ${text(row.evaluated_policy_state)} @ ${percent(row.evaluated_threshold)}`,
            [text(row.status), text(row.resolution_action), item(row.resolver_actor_id, row.resolver_actor_type), text(row.resolved_at_utc)].filter(Boolean).join(" · "),
            `${text(row.workflow_id)} / ${text(row.run_id)} / #${text(row.attempt_number)}`,
            text(row.resulting_operation_id),
            text(row.compensation_operation_id),
            text(row.resulting_relation_id),
            text(row.created_at_utc),
          ])}
        />
      </Section>
      <Section title="Activation notifications" description="Одно informational notification на policy; body намеренно не выводится.">
        <DataTable columns={["Notification", "Kind", "Policy", "Title", "Status", "Created"]} rows={summary.notifications.map((row) => [code(row.id), text(row.kind), text(row.policies_id), text(row.title), text(row.status), text(row.created_at_utc)])} />
      </Section>
    </div>
  );
}

function PoliciesView({ summary }: { summary: ContextObservabilitySummary }) {
  return (
    <div className="grid gap-3.5">
      <Section title="Calibration policies" description="Exact-version key, measured threshold/precision, shadow reason и audit schedule.">
        <DataTable
          columns={["Policy", "Agent key", "Kind", "State", "Threshold", "Labels", "Precision", "Auto since audit", "Audits", "Shadow reason", "Updated"]}
          rows={summary.policies.map((row) => [
            code(row.id),
            `${text(row.agent_id)} ${text(row.agent_version)} · ${text(row.prompt_version)} · ${text(row.model)} · ${text(row.schema_version)}`,
            text(row.decision_kind),
            text(row.state),
            percent(row.active_threshold),
            `${number(row.positive_label_count)} / ${number(row.label_count)}`,
            percent(row.observed_precision),
            number(row.auto_accept_count_since_audit),
            `${number(row.pending_audits)} pending / ${number(row.overdue_audits)} overdue`,
            text(row.shadow_reason),
            text(row.updated_at_utc),
          ])}
        />
      </Section>
      <Section title="Calibration labels" description="Review, audit и undo labels — измеряемые outcomes, не manual domain mutations.">
        <DataTable columns={["Label", "Policy", "Decision", "Source", "Accepted", "Confidence", "Created"]} rows={summary.labels.map((row) => [code(row.id), text(row.policies_id), text(row.decisions_id), text(row.source), yesNo(row.accepted), percent(row.confidence), text(row.created_at_utc)])} />
      </Section>
      <Section title="Audit batches" description="Пятиэлементные batches, due date и outcome counts; decision IDs остаются ссылуемыми.">
        <DataTable columns={["Batch", "Policy", "Status", "Window", "Due", "Items", "Outcomes", "Sample"]} rows={summary.audits.map((row) => [code(row.id), text(row.policies_id), text(row.status), `${text(row.window_started_at_utc)} → ${text(row.window_ended_at_utc)}`, text(row.due_at_utc), number(row.item_count), `${number(row.confirmed_count)} ok / ${number(row.rejected_count)} rejected / ${number(row.pending_count)} pending`, auditItems(row.items)])} />
      </Section>
    </div>
  );
}

function OperationsView({ summary }: { summary: ContextObservabilitySummary }) {
  return (
    <div className="grid gap-3.5">
      <Section title="Deterministic operations" description="Idempotent apply/compensation outcomes без raw result или compensation payload.">
        <DataTable columns={["Operation", "Kind", "Status", "Original", "Result shape", "Compensation shape", "Decisions", "Error", "Updated"]} rows={summary.operations.map((row) => [code(row.id), text(row.kind), text(row.status), text(row.original_operation_id), list(row.result_keys), list(row.compensation_keys), number(row.decision_count), text(row.last_error), text(row.updated_at_utc)])} />
      </Section>
      <Section title="Discovery watermarks" description="Restart-safe relevant/processed ranges и не более одного active workflow на user.">
        <DataTable columns={["User", "Relevant", "Processed", "Pending changes", "Last change", "Execution", "Workflow / run", "Status", "Updated"]} rows={summary.watermarks.map((row) => [code(row.user_id), number(row.relevant_sequence), number(row.processed_sequence), number(row.relevant_change_count), text(row.last_relevant_change_at_utc), text(row.active_workflow_execution_id), `${text(row.workflow_id)} / ${text(row.run_id)}`, text(row.workflow_status), text(row.updated_at_utc)])} />
      </Section>
    </div>
  );
}

function AgentsView({ summary }: { summary: ContextObservabilitySummary }) {
  return (
    <div className="grid gap-3.5">
      <Section title="Five specialized agents" description="Registry contracts без prompt template; один agent — одна ответственность и version identity.">
        <DataTable columns={["Agent", "Version", "Status", "Target / kind", "Summary", "Provider / model", "Timeout", "Source", "Updated"]} rows={summary.agents.map((row) => [code(row.id), text(row.version), text(row.status), `${text(row.target)} / ${text(row.kind)}`, text(row.summary), `${text(row.llm_provider)} / ${text(row.llm_model)}`, text(row.llm_timeout_ms), text(row.source_module), text(row.updated_at_utc)])} />
      </Section>
      <Section title="Services, queues and workflows" description="Environment queue, exact poller heartbeat, runs/failures и pinned input/output schema versions.">
        <DataTable columns={["Workflow", "Version", "Status", "Queue / template", "Poller", "Worker build", "Last seen", "Active", "Failed", "Schemas", "Last execution"]} rows={summary.services.map((row) => [code(row.id), number(row.version), text(row.status), queue(row), text(row.worker_identity), text(row.build_ref), text(row.last_seen_at_utc), number(row.active_count), number(row.failed_count), `${text(row.input_schema_version)} → ${text(row.output_schema_version)}`, text(row.last_execution_at)])} />
      </Section>
      <Section title="AI attempts" description="Последние observable completed/provider-failed calls; технические ссылки без json_data.">
        <DataTable columns={["AI log", "Agent", "Version", "Status", "Workflow / run", "Attempt", "Trace", "Time"]} rows={summary.aiLogs.map((row) => [code(row.id), text(row.agent_id), text(row.agent_version), text(row.status), `${text(row.workflow_id)} / ${text(row.run_id)}`, text(row.attempt_number), text(row.trace_id), text(row.dt)])} />
      </Section>
    </div>
  );
}

function DiagnosticsView({ summary }: { summary: ContextObservabilitySummary }) {
  return (
    <Section title="Integrity diagnostics" description="Bounded aggregate checks; каждый non-zero count требует расследования, но Admin не выполняет repair.">
      <DataTable columns={["Status", "Check", "Count", "Meaning"]} rows={summary.diagnostics.map((row) => [Number(row.count) === 0 ? <Badge key="ok">healthy</Badge> : <Badge key="bad" variant="destructive">broken</Badge>, code(row.key), number(row.count), text(row.description)])} />
    </Section>
  );
}

function Section({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return <section className="grid gap-2"><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><h2 className="m-0 text-base font-semibold">{title}</h2><p className="m-0 mt-1 text-sm text-muted-foreground">{description}</p></div></div>{children}</section>;
}

function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <Table className="text-xs" variant="card">
      <TableHeader><TableRow>{columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{rows.length ? rows.map((row, index) => <TableRow key={index}>{row.map((cell, cellIndex) => <TableCell className="max-w-[28rem] !whitespace-normal !leading-5 [overflow-wrap:anywhere]" key={cellIndex}>{cell}</TableCell>)}</TableRow>) : <TableRow><TableCell className="text-muted-foreground" colSpan={columns.length}>Данных пока нет.</TableCell></TableRow>}</TableBody>
    </Table>
  );
}

function activeTab(value: string | undefined): ContextTab { return TABS.some(([id]) => id === value) ? value as ContextTab : "contracts"; }
function contextHref(tab: ContextTab, relationPage = 1) {
  const params = new URLSearchParams({ section: "context", tab });
  if (relationPage > 1) params.set("relationPage", String(relationPage));
  return `/?${params}`;
}
function text(value: unknown) { return value == null ? "" : String(value); }
function number(value: unknown) { return Number(value ?? 0); }
function yesNo(value: unknown) { return Number(value) === 1 ? "да" : "нет"; }
function percent(value: unknown) { return value == null || value === "" ? "" : `${Math.round(Number(value) * 1000) / 10}%`; }
function code(value: unknown) { const label = text(value); return label ? <code>{label}</code> : ""; }
function excerpt(value: unknown, truncated: unknown) {
  const content = text(value);
  return content ? `${content}${truncated ? "…" : ""}` : "";
}
function payloadDetails(label: string, value: unknown, truncated: unknown) {
  const content = excerpt(value, truncated);
  return content ? (
    <details>
      <summary className="cursor-pointer">{label}</summary>
      <pre className="m-0 mt-1 max-w-[24rem] whitespace-pre-wrap break-words">{content}</pre>
    </details>
  ) : label;
}
function item(id: unknown, label: unknown) { return [text(label), text(id)].filter(Boolean).join(" · "); }
function queue(row: ContextRow) {
  const actual = text(row.task_queue);
  const template = text(row.definition_task_queue);
  return actual && template && actual !== template ? `${actual} · template ${template}` : actual || template;
}
function list(value: unknown) { return Array.isArray(value) ? value.map(text).filter(Boolean).join(", ") : text(value); }
function rules(value: unknown) { return Array.isArray(value) ? value.map((rule) => { const row = rule as ContextRow; return `${text(row.source_role_key)}/${text(row.source_type_key)} → ${text(row.target_role_key)}/${text(row.target_type_key)}`; }).join("; ") : ""; }
function auditItems(value: unknown) { return Array.isArray(value) ? value.map((entry) => { const row = entry as ContextRow; return `#${text(row.position)} ${text(row.sample_kind)}:${text(row.status)} ${text(row.decision_id)}`; }).join("; ") : ""; }
