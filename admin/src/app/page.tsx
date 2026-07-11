import Link from "next/link";
import Image from "next/image";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { ArrowDownUp, CalendarClock, ChevronDown, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Command, Database, FileKey2, Table2, Workflow } from "lucide-react";
import { AnimatedThemeToggler } from "@/shared/ui/animated-theme-toggler";
import { BraiCmdAdminSection } from "@/app/BraiCmdAdminSection";
import { Badge } from "@/shared/ui/badge";
import { ButtonLink } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardFrame, CardHeader, CardTitle } from "@/shared/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { formatBytes, formatCell } from "@/lib/format";
import { PAGE_SIZE, readDatabaseView, readPrimaryUserId, readRoleContractsAdmin, readWorkflowAdminSummary } from "@/lib/database";
import { readBraiCmdAdminSummary } from "@/lib/braiCmdSummary";
import type { DbForeignKey, DbIncomingForeignKey, DbSortDirection, DbTable, DbView } from "@/lib/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type AdminAccess = { status: "allowed" | "forbidden" | "not_configured" | "signed_out" | "unavailable" };
type AdminSessionResponse = { authenticated?: boolean; user?: { id?: unknown } | null };
type RequestHeaders = { get(name: string): string | null };
type SectionName = "database" | "handlers" | "schedules" | "workflows" | "role-contracts" | "brai-cmd";
type TabName = "rows" | "relations" | "columns" | "indexes";

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const requestHeaders = await headers();
  const access = await readAdminAccess(requestHeaders);
  if (access.status !== "allowed") return <AdminAccessPanel loginHref={resolveLoginHref(requestHeaders)} status={access.status} />;

  const params = await searchParams;
  const requestedTable = first(params.table);
  const requestedPage = Number(first(params.page) ?? "1");
  const activeSection = parseSection(first(params.section));
  const activeTab = parseTab(first(params.tab));
  const sortDirection = parseSortDirection(first(params.sort));
  const view = await readDatabaseView({
    tableName: fixedSectionTable(activeSection) ?? requestedTable,
    page: requestedPage,
    pageSize: PAGE_SIZE,
    sortDirection,
  });
  const braiCmdSummary = activeSection === "brai-cmd" ? await readBraiCmdAdminSummary() : null;
  const workflowSummary = activeSection === "workflows" ? await readWorkflowAdminSummary() : null;
  const roleContracts = activeSection === "role-contracts" ? await readRoleContractsAdmin() : null;
  const selectedName = view.selectedTable?.name ?? "";

  return (
    <main className="admin-shell grid h-dvh min-h-0 bg-background text-foreground max-md:grid-rows-[auto_minmax(0,2fr)_minmax(0,3fr)] md:grid-cols-[4.5rem_20rem_minmax(0,1fr)]">
      <PrimaryRail activeSection={activeSection} />
      {activeSection === "handlers" ? (
        <HandlersRail count={view.rowCount} />
      ) : activeSection === "workflows" && workflowSummary ? (
        <MetadataRail count={workflowSummary.definitions.length} title="Workflows" />
      ) : activeSection === "role-contracts" && roleContracts ? (
        <MetadataRail count={roleContracts.length} title="Role contracts" />
      ) : activeSection === "schedules" ? (
        <SchedulesRail count={view.selectedTable?.name === "handler_schedules" ? view.rowCount : 0} />
      ) : activeSection === "brai-cmd" && braiCmdSummary ? (
        <BraiCmdRail summary={braiCmdSummary} />
      ) : (
        <TableRail selectedName={selectedName} stats={view.stats} tables={view.tables} />
      )}
      <section className="min-h-0 min-w-0 p-3 md:p-4">
        <ScrollArea className="-mr-3 h-full min-h-0 min-w-0 pr-3 md:-mr-4 md:pr-4" contentInset="none">
          <div className="grid min-w-0 gap-3.5 pb-6">
            {activeSection === "handlers" ? (
              <HandlersSection rows={view.selectedTable?.name === "handlers" ? view.rows : []} />
            ) : activeSection === "workflows" && workflowSummary ? (
              <WorkflowsSection summary={workflowSummary} />
            ) : activeSection === "role-contracts" && roleContracts ? (
              <RoleContractsSection rows={roleContracts} />
            ) : activeSection === "schedules" ? (
              <SchedulesSection sortDirection={sortDirection} view={view} />
            ) : activeSection === "brai-cmd" && braiCmdSummary ? (
              <BraiCmdAdminSection summary={braiCmdSummary} />
            ) : view.selectedTable ? (
              <>
                <EntityHeader description={view.tableDescription} tableName={view.selectedTable.name} />
                <TableTabs activeTab={activeTab} page={view.page} sortDirection={sortDirection} tableName={view.selectedTable.name} />
                {activeTab === "rows" ? (
                  <RowsPanel
                    columns={view.columns.map((column) => column.name)}
                    page={view.page}
                    pageCount={view.pageCount}
                    pageSize={view.pageSize}
                    rowCount={view.rowCount}
                    rows={view.rows}
                    sortDirection={sortDirection}
                    tableName={view.selectedTable.name}
                    foreignKeys={view.foreignKeys}
                  />
                ) : null}
                {activeTab === "relations" ? <RelationsPanel foreignKeys={view.foreignKeys} referencedBy={view.referencedBy} /> : null}
                {activeTab === "columns" ? <ColumnsPanel columns={view.columns} foreignKeys={view.foreignKeys} /> : null}
                {activeTab === "indexes" ? <IndexesPanel indexes={view.indexes} /> : null}
              </>
            ) : (
              <Card className="p-6">
                <p className="m-0 text-sm text-muted-foreground">В базе данных нет таблиц.</p>
              </Card>
            )}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

async function readAdminAccess(requestHeaders: RequestHeaders): Promise<AdminAccess> {
  try {
    const userId = await readAuthenticatedUserId(requestHeaders);
    if (!userId) return { status: "signed_out" };

    const primaryUserId = await readPrimaryUserId();
    if (!primaryUserId) return { status: "not_configured" };
    return { status: userId === primaryUserId ? "allowed" : "forbidden" };
  } catch (error) {
    console.error("Brai Admin auth check failed", error);
    return { status: "unavailable" };
  }
}

async function readAuthenticatedUserId(requestHeaders: RequestHeaders) {
  const cookie = requestHeaders.get("cookie");
  if (!cookie) return null;

  const response = await fetch(`${resolveAdminApiBase()}/auth/session`, {
    cache: "no-store",
    headers: { cookie },
  });
  if (!response.ok) throw new Error(`Brai API session check failed: ${response.status}`);

  const session = (await response.json()) as AdminSessionResponse;
  const userId = session.authenticated ? session.user?.id : null;
  return typeof userId === "string" && userId ? userId : null;
}

function resolveAdminApiBase() {
  const value = process.env.BRAI_ADMIN_API_BASE ?? "http://127.0.0.1:3020";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BRAI_ADMIN_API_BASE must be an HTTP URL");
  return url.href.replace(/\/+$/, "");
}

function resolveLoginHref(requestHeaders: RequestHeaders) {
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) return "/";
  const proto = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("127.") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/`;
}

function AdminAccessPanel({ loginHref, status }: { loginHref: string; status: Exclude<AdminAccess["status"], "allowed"> }) {
  const copy = {
    forbidden: {
      title: "Доступ закрыт",
      text: "Админка доступна только основному аккаунту Brai.",
    },
    not_configured: {
      title: "Основной аккаунт не задан",
      text: "Сначала войдите в основное приложение, чтобы Brai назначил primary user.",
    },
    signed_out: {
      title: "Требуется вход",
      text: "Войдите в основной аккаунт Brai, затем вернитесь в админку.",
    },
    unavailable: {
      title: "Админка временно недоступна",
      text: "Не удалось проверить сессию через Brai API.",
    },
  }[status];

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4 text-foreground">
      <Card className="grid w-full max-w-md gap-4 p-6">
        <div className="grid gap-2">
          <h1 className="m-0 text-xl font-semibold">{copy.title}</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">{copy.text}</p>
        </div>
        {status === "signed_out" || status === "not_configured" ? (
          <a className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90" href={loginHref}>
            Войти в Brai
          </a>
        ) : null}
      </Card>
    </main>
  );
}

function EntityHeader({
  description,
  tableName,
}: {
  description: { title: string; short_description: string; long_description: string } | null;
  tableName: string;
}) {
  const title = description?.title ?? tableName;
  const shortDescription = description?.short_description ?? "Описание этой таблицы пока не заполнено.";
  const paragraphs = (description?.long_description ?? "Добавьте строку в table_descriptions, чтобы описать назначение этой таблицы.")
    .split("\n")
    .filter(Boolean);

  return (
    <Card>
      <Collapsible>
        <CardHeader className="gap-3 p-4 md:p-5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Table2 className="size-4 shrink-0" />
            <code className="min-w-0 truncate">{tableName}</code>
          </div>
          <h1 className="m-0 min-w-0">
            <CollapsibleTrigger
              className="group flex min-w-0 items-center gap-2 rounded-md text-left text-2xl font-semibold leading-none outline-none transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:[&_svg]:rotate-180"
              type="button"
            >
              <span className="min-w-0 break-words">{title}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform" />
            </CollapsibleTrigger>
          </h1>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="grid gap-2 px-4 pb-4 pt-0 text-sm leading-6 text-muted-foreground md:px-5 md:pb-5">
            <p className="m-0 text-base font-medium leading-6 text-foreground">{shortDescription}</p>
            {paragraphs.map((paragraph) => (
              <p className="m-0" key={paragraph}>{paragraph}</p>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function PrimaryRail({ activeSection }: { activeSection: SectionName }) {
  return (
    <aside className="flex items-center gap-2 border-b bg-card px-3 py-2 md:min-h-0 md:flex-col md:border-b-0 md:border-r md:px-0 md:py-3">
      <nav className="flex min-w-0 gap-2 overflow-x-auto md:flex-col md:overflow-visible" aria-label="Основное меню">
        <ButtonLink
          aria-current={activeSection === "database" ? "page" : undefined}
          href="/"
          size="icon-lg"
          variant={activeSection === "database" ? "default" : "outline"}
        >
          <Database className="size-5" />
          <span className="sr-only">База данных</span>
        </ButtonLink>
        <ButtonLink
          aria-current={activeSection === "handlers" ? "page" : undefined}
          href="/?section=handlers"
          size="icon-lg"
          variant={activeSection === "handlers" ? "default" : "outline"}
        >
          <Workflow className="size-5" />
          <span className="sr-only">Обработчики</span>
        </ButtonLink>
        <ButtonLink
          aria-current={activeSection === "schedules" ? "page" : undefined}
          href="/?section=schedules"
          size="icon-lg"
          variant={activeSection === "schedules" ? "default" : "outline"}
        >
          <CalendarClock className="size-5" />
          <span className="sr-only">Расписания автоматизаций</span>
        </ButtonLink>
        <ButtonLink
          aria-current={activeSection === "workflows" ? "page" : undefined}
          href="/?section=workflows"
          size="icon-lg"
          variant={activeSection === "workflows" ? "default" : "outline"}
        >
          <Workflow className="size-5" />
          <span className="sr-only">Product workflows</span>
        </ButtonLink>
        <ButtonLink
          aria-current={activeSection === "role-contracts" ? "page" : undefined}
          href="/?section=role-contracts"
          size="icon-lg"
          variant={activeSection === "role-contracts" ? "default" : "outline"}
        >
          <FileKey2 className="size-5" />
          <span className="sr-only">Role contracts</span>
        </ButtonLink>
        <ButtonLink
          aria-current={activeSection === "brai-cmd" ? "page" : undefined}
          href="/?section=brai-cmd"
          size="icon-lg"
          variant={activeSection === "brai-cmd" ? "default" : "outline"}
        >
          <Command className="size-5" />
          <span className="sr-only">Brai Cmd</span>
        </ButtonLink>
      </nav>
      <AnimatedThemeToggler
        aria-label="Переключить тему"
        className="ml-auto inline-grid size-11 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:ml-0 md:mt-auto [&_svg]:size-4"
        title="Переключить тему"
        variant="circle"
      />
    </aside>
  );
}

function MetadataRail({ count, title }: { count: number; title: string }) {
  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid content-start gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted-foreground">{count} записей</div>
        </header>
        <Card className="p-3">
          <p className="m-0 text-sm text-muted-foreground">Read-only operational metadata.</p>
        </Card>
      </div>
    </aside>
  );
}

function WorkflowsSection({ summary }: { summary: Awaited<ReturnType<typeof readWorkflowAdminSummary>> }) {
  return (
    <>
      <Card>
        <CardHeader className="gap-2 p-4 md:p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Workflow className="size-4" />Process source of truth</div>
          <h1 className="m-0 text-2xl font-semibold leading-none">Workflows</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">Версии, JSON schemas, Mermaid/Kroki diagrams и последние executions.</p>
        </CardHeader>
      </Card>
      <div className="grid gap-3.5">
        {summary.definitions.map((definition) => (
          <Card className="grid gap-4 p-4" key={`${text(definition, "id")}:${text(definition, "version")}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <h2 className="m-0 text-lg font-semibold">{text(definition, "title")}</h2>
                <code className="text-xs text-muted-foreground">{text(definition, "id")} v{text(definition, "version")}</code>
              </div>
              <div className="flex gap-2"><Badge>{text(definition, "status")}</Badge><Badge variant="outline">{text(definition, "task_queue")}</Badge></div>
            </div>
            <p className="m-0 text-sm text-muted-foreground">{text(definition, "description")}</p>
            {typeof definition.diagramDataUrl === "string" ? (
              <div className="overflow-hidden rounded-lg border border-border bg-background p-3">
                <Image className="h-auto w-full" src={definition.diagramDataUrl} alt={`Workflow ${text(definition, "title")}`} width={900} height={360} unoptimized />
              </div>
            ) : (
              <pre className="m-0 overflow-x-auto rounded-lg border border-border bg-muted/35 p-3 text-xs">{text(definition, "diagram_mermaid")}</pre>
            )}
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div>Input: <code>{text(definition, "input_schema_version")}</code></div>
              <div>Output: <code>{text(definition, "output_schema_version")}</code></div>
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              <SchemaDetails label="Input schema" value={text(definition, "input_schema_json")} />
              <SchemaDetails label="Output schema" value={text(definition, "output_schema_json")} />
            </div>
          </Card>
        ))}
      </div>
      <Panel description={`${summary.executions.length} последних запусков`} title="Workflow executions">
        <Card className="divide-y divide-border overflow-hidden">
          {summary.executions.length ? summary.executions.map((execution) => (
            <div className="grid gap-2 p-3 text-sm md:grid-cols-[minmax(0,1fr)_auto]" key={text(execution, "workflow_id")}>
              <div className="grid min-w-0 gap-1">
                <code className="truncate text-xs">{text(execution, "workflow_id")}</code>
                <span className="text-muted-foreground">{text(execution, "current_step")} · attempts {text(execution, "attempt_count")}</span>
                <span className="break-all text-xs text-muted-foreground">run {text(execution, "run_id") || "—"} · raw {text(execution, "raw_record_id")}</span>
                {text(execution, "last_error") ? <span className="text-destructive">{text(execution, "last_error")}</span> : null}
              </div>
              <Badge variant="outline">{text(execution, "status")}</Badge>
            </div>
          )) : <p className="m-0 p-4 text-sm text-muted-foreground">Запусков пока нет.</p>}
        </Card>
      </Panel>
    </>
  );
}

function SchemaDetails({ label, value }: { label: string; value: string }) {
  return (
    <details className="rounded-lg border border-border bg-muted/20 p-3">
      <summary className="cursor-pointer text-sm font-medium">{label}</summary>
      <pre className="mb-0 mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{value}</pre>
    </details>
  );
}

function RoleContractsSection({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <>
      <Card>
        <CardHeader className="gap-2 p-4 md:p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><FileKey2 className="size-4" />Agent context</div>
          <h1 className="m-0 text-2xl font-semibold leading-none">Role contracts</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">Role table, lifecycle, workflow ownership, schemas и event rules.</p>
        </CardHeader>
      </Card>
      <div className="grid gap-3.5 lg:grid-cols-2">
        {rows.map((row) => (
          <Card className="grid gap-3 p-4" key={text(row, "id")}>
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="m-0 text-base font-semibold">{text(row, "role_title")}</h2><code className="text-xs text-muted-foreground">{text(row, "role_key")}</code></div>
              <Badge variant="outline">{text(row, "owner")}</Badge>
            </div>
            <dl className="m-0 grid gap-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Payload</dt><dd className="m-0"><code>{text(row, "payload_table")}.{text(row, "link_column")}</code></dd></div>
              <div><dt className="text-xs text-muted-foreground">Workflow</dt><dd className="m-0">{text(row, "workflow_title") || "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Schemas</dt><dd className="m-0 break-words">{text(row, "input_schema_version") || "—"} → {text(row, "output_schema_version") || "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Lifecycle</dt><dd className="m-0 break-words font-mono text-xs">{text(row, "lifecycle_json")}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Events</dt><dd className="m-0 break-words font-mono text-xs">{text(row, "event_rules_json")}</dd></div>
            </dl>
          </Card>
        ))}
      </div>
    </>
  );
}

function BraiCmdRail({ summary }: { summary: Awaited<ReturnType<typeof readBraiCmdAdminSummary>> }) {
  const items = [
    ["Активные", summary.totals.activeTokens],
    ["Запросы", summary.totals.requests],
    ["Ошибки", summary.totals.errors],
  ];

  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">Brai Cmd</div>
          <div className="text-xs text-muted-foreground">{summary.recentUsage.length} последних событий</div>
        </header>
        <Card className="p-3">
          <dl className="m-0 grid gap-2">
            {items.map(([label, value]) => (
              <div className="flex items-center justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0" key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="m-0 text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </aside>
  );
}

function SchedulesRail({ count }: { count: number }) {
  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">Автоматизации</div>
          <div className="text-xs text-muted-foreground">{count} расписаний</div>
        </header>
        <Card className="p-3">
          <p className="m-0 text-sm text-muted-foreground">Данные из таблицы handler_schedules.</p>
        </Card>
      </div>
    </aside>
  );
}

function SchedulesSection({ sortDirection, view }: { sortDirection: DbSortDirection; view: DbView }) {
  const tableName = "handler_schedules";
  const hasTable = view.selectedTable?.name === tableName;

  return (
    <>
      <Card>
        <CardHeader className="gap-2 p-4 md:p-5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <CalendarClock className="size-4 shrink-0" />
            <span>Автоматизации</span>
          </div>
          <h1 className="m-0 text-2xl font-semibold leading-none">Расписания</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">
            {view.tableDescription?.short_description ?? "Расписания runtime-обработчиков Brai из базы данных."}
          </p>
        </CardHeader>
      </Card>
      {hasTable ? (
        <RowsPanel
          columns={view.columns.map((column) => column.name)}
          foreignKeys={view.foreignKeys}
          page={view.page}
          pageCount={view.pageCount}
          pageSize={view.pageSize}
          rowCount={view.rowCount}
          rows={view.rows}
          section="schedules"
          sortDirection={sortDirection}
          tableName={tableName}
          title="Таблица расписаний"
        />
      ) : (
        <EmptyPanel>В базе данных нет таблицы handler_schedules.</EmptyPanel>
      )}
    </>
  );
}

function HandlersRail({ count }: { count: number }) {
  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-3">
        <header className="grid gap-1">
          <div className="text-sm font-semibold">Обработчики</div>
          <div className="text-xs text-muted-foreground">{count} карточек</div>
        </header>
        <Card className="p-3">
          <p className="m-0 text-sm text-muted-foreground">Данные из таблицы handlers.</p>
        </Card>
      </div>
    </aside>
  );
}

function HandlersSection({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <>
      <Card>
        <CardHeader className="gap-2 p-4 md:p-5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Workflow className="size-4 shrink-0" />
            <span>Раздел</span>
          </div>
          <h1 className="m-0 text-2xl font-semibold leading-none">Обработчики</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">Карточки обработчиков Brai из базы данных.</p>
        </CardHeader>
      </Card>
      <Panel description={`${rows.length} обработчиков`} title="Карточки обработчиков">
        {rows.length ? (
          <div className="grid gap-3.5 lg:grid-cols-2">
            {rows.map((row) => (
              <HandlerCard key={text(row, "id")} row={row} />
            ))}
          </div>
        ) : (
          <EmptyPanel>В таблице handlers нет строк.</EmptyPanel>
        )}
      </Panel>
    </>
  );
}

function HandlerCard({ row }: { row: Record<string, unknown> }) {
  const llm = [text(row, "llm_provider"), text(row, "llm_model")].filter(Boolean).join(" / ");

  return (
    <Card className="min-w-0">
      <Collapsible>
        <CollapsibleTrigger
          className="grid h-32 w-full grid-rows-[auto_1fr_auto] gap-2 rounded-2xl p-4 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:rounded-b-none data-[state=open]:[&_svg]:rotate-180"
          type="button"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge>{text(row, "status") || "status"}</Badge>
            <Badge variant="outline">{text(row, "target") || "target"}</Badge>
          </div>
          <div className="grid gap-1">
            <h2 className="m-0 line-clamp-2 text-base font-semibold leading-snug">{text(row, "title") || text(row, "id")}</h2>
            <p className="m-0 line-clamp-2 text-sm leading-5 text-muted-foreground">{text(row, "summary")}</p>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
            <code className="min-w-0 truncate">{text(row, "id")}</code>
            <ChevronDown className="size-4 shrink-0 transition-transform" aria-hidden="true" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 border-t p-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{text(row, "kind") || "kind"}</Badge>
              <Badge variant="outline">{llm || "без LLM"}</Badge>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <HandlerDetail label="Триггер" value={text(row, "trigger_description")} />
              <HandlerDetail label="Условия" value={text(row, "conditions_description")} />
              <HandlerDetail label="Вход" value={text(row, "input_description")} />
              <HandlerDetail label="Выход" value={text(row, "output_description")} />
              <HandlerDetail label="Взаимодействия" value={text(row, "interactions_description")} />
              <HandlerDetail label="Побочные эффекты" value={text(row, "side_effects_description")} />
              <HandlerDetail label="Fallback" value={text(row, "fallback_description")} />
              <HandlerDetail label="Prompt" value={text(row, "llm_prompt_template")} />
            </div>
            <footer className="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
              <span>{text(row, "source_module")}</span>
              <span>{text(row, "updated_at_utc")}</span>
            </footer>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function HandlerDetail({ label, value }: { label: string; value: string }) {
  if (!value) return null;

  return (
    <section className="grid gap-1">
      <h3 className="m-0 text-xs font-semibold uppercase text-muted-foreground">{label}</h3>
      <p className="m-0 text-sm leading-6">{value}</p>
    </section>
  );
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value);
}

function TableRail({
  selectedName,
  stats,
  tables,
}: {
  selectedName: string;
  stats: { databaseSizeBytes: number; tableCount: number; totalRows: number };
  tables: DbTable[];
}) {
  const tableGroups = groupTables(tables);

  return (
    <aside className="grid min-h-0 border-b bg-card md:border-b-0 md:border-r">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-3">
        <header className="grid gap-3">
          <div>
            <div className="text-sm font-semibold">Brai Admin</div>
            <div className="text-xs text-muted-foreground">{tables.length} объектов базы данных</div>
          </div>
        </header>
        <ScrollArea className="-mr-3 min-h-0 min-w-0 pr-3" contentInset="none">
          <div className="grid min-w-0 gap-4">
            <TableRailGroup selectedName={selectedName} tables={tableGroups.user} title="Пользовательские данные" />
            <TableRailGroup selectedName={selectedName} tables={tableGroups.system} title="Системные" />
          </div>
        </ScrollArea>
        <DatabaseRailStats stats={stats} />
      </div>
    </aside>
  );
}

function TableRailGroup({ selectedName, tables, title }: { selectedName: string; tables: DbTable[]; title: string }) {
  if (!tables.length) return null;

  return (
    <section className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-2.5 py-2 text-xs font-semibold uppercase text-muted-foreground">
        <span className="truncate">{title}</span>
        <span>{tables.length}</span>
      </div>
      {tables.map((table) => {
        const title = table.description?.title ?? table.name;
        const active = table.name === selectedName;
        return (
          <ButtonLink
            className="h-auto justify-between px-2 py-2 text-left"
            href={databaseHref({ table: table.name, page: 1 })}
            key={table.name}
            variant={active ? "secondary" : "ghost"}
          >
            <span className="min-w-0 truncate" title={table.name}>{title}</span>
            <Badge>{table.rowCount}</Badge>
          </ButtonLink>
        );
      })}
    </section>
  );
}

function groupTables(tables: DbTable[]) {
  return {
    user: tables.filter((table) => table.group === "user"),
    system: tables.filter((table) => table.group === "system"),
  };
}

function DatabaseRailStats({ stats }: { stats: { databaseSizeBytes: number; tableCount: number; totalRows: number } }) {
  const items = [
    ["Размер", formatBytes(stats.databaseSizeBytes)],
    ["Таблицы", stats.tableCount],
    ["Строки", stats.totalRows],
  ];

  return (
    <Card className="hidden p-3 md:flex">
      <dl className="m-0 grid gap-2">
        {items.map(([label, value]) => (
          <div className="flex items-center justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0" key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="m-0 break-words text-right text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function TableTabs({
  activeTab,
  page,
  sortDirection,
  tableName,
}: {
  activeTab: TabName;
  page: number;
  sortDirection: DbSortDirection;
  tableName: string;
}) {
  const tabs: Array<{ id: TabName; label: string; href: string }> = [
    { id: "rows", label: "Строки", href: databaseHref({ table: tableName, tab: "rows", page, sort: sortDirection }) },
    { id: "relations", label: "Связи", href: databaseHref({ table: tableName, tab: "relations" }) },
    { id: "columns", label: "Столбцы", href: databaseHref({ table: tableName, tab: "columns" }) },
    { id: "indexes", label: "Индексы", href: databaseHref({ table: tableName, tab: "indexes" }) },
  ];

  return (
    <nav className="flex flex-wrap gap-2" aria-label="Данные таблицы">
      {tabs.map((tab) => (
        <ButtonLink key={tab.id} href={tab.href} variant={tab.id === activeTab ? "default" : "outline"}>
          {tab.label}
        </ButtonLink>
      ))}
    </nav>
  );
}

function ColumnsPanel({
  columns,
  foreignKeys,
}: {
  columns: Array<{ cid: number; name: string; type: string; isNotNull: number; dflt_value: string | null; pk: number; hidden: number }>;
  foreignKeys: DbForeignKey[];
}) {
  return (
    <Panel title="Столбцы">
      <Table variant="card">
        <TableHeader>
          <TableRow>
            {["#", "name", "type", "not null", "default", "pk", "hidden"].map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {columns.map((column) => (
            <ColumnRow key={`${column.cid}:${column.name}`} column={column} reference={foreignKeyForColumn(foreignKeys, column.name)} />
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function ColumnRow({
  column,
  reference,
}: {
  column: { cid: number; name: string; type: string; isNotNull: number; dflt_value: string | null; pk: number; hidden: number };
  reference: DbForeignKey | undefined;
}) {
  return (
    <TableRow>
      <TableCell>{column.cid}</TableCell>
      <TableCell className="font-mono">
        <div>{column.name}</div>
        {reference ? <ReferenceLink reference={reference} /> : null}
      </TableCell>
      <TableCell>{column.type || "-"}</TableCell>
      <TableCell>{column.isNotNull ? "yes" : "no"}</TableCell>
      <TableCell className="font-mono">{formatCell(column.dflt_value)}</TableCell>
      <TableCell>{column.pk || "-"}</TableCell>
      <TableCell>{column.hidden || "-"}</TableCell>
    </TableRow>
  );
}

function RelationsPanel({
  foreignKeys,
  referencedBy,
}: {
  foreignKeys: DbForeignKey[];
  referencedBy: DbIncomingForeignKey[];
}) {
  return (
    <section className="grid gap-3.5 xl:grid-cols-2">
      <RelationTable empty="Эта таблица никуда не ссылается." relations={foreignKeys} title="Куда ссылается эта таблица" />
      <IncomingRelationTable empty="На эту таблицу никто не ссылается." relations={referencedBy} title="Кто ссылается на эту таблицу" />
    </section>
  );
}

function RelationTable({ empty, relations, title }: { empty: string; relations: DbForeignKey[]; title: string }) {
  return (
    <Panel title={title}>
      {relations.length ? (
        <Table variant="card">
          <TableHeader>
            <TableRow>
              {["столбец", "таблица", "столбец цели", "update", "delete"].map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {relations.map((relation) => (
              <TableRow key={`${relation.id}:${relation.seq}:${relation.sourceColumn}`}>
                <TableCell className="font-mono">{relation.sourceColumn}</TableCell>
                <TableCell><TableTitleLink tableName={relation.targetTable} title={relation.targetTitle} /></TableCell>
                <TableCell className="font-mono">{relation.targetColumn}</TableCell>
                <TableCell>{relation.on_update}</TableCell>
                <TableCell>{relation.on_delete}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyPanel>{empty}</EmptyPanel>
      )}
    </Panel>
  );
}

function IncomingRelationTable({ empty, relations, title }: { empty: string; relations: DbIncomingForeignKey[]; title: string }) {
  return (
    <Panel title={title}>
      {relations.length ? (
        <Table variant="card">
          <TableHeader>
            <TableRow>
              {["таблица", "столбец", "столбец цели", "update", "delete"].map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {relations.map((relation) => (
              <TableRow key={`${relation.sourceTable}:${relation.id}:${relation.seq}:${relation.sourceColumn}`}>
                <TableCell><TableTitleLink tableName={relation.sourceTable} title={relation.sourceTitle} /></TableCell>
                <TableCell className="font-mono">{relation.sourceColumn}</TableCell>
                <TableCell className="font-mono">{relation.targetColumn}</TableCell>
                <TableCell>{relation.on_update}</TableCell>
                <TableCell>{relation.on_delete}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyPanel>{empty}</EmptyPanel>
      )}
    </Panel>
  );
}

function IndexesPanel({
  indexes,
}: {
  indexes: Array<{ name: string; isUnique: number; origin: string; partial: number; columns: string[] }>;
}) {
  return (
    <Panel title="Индексы">
      {indexes.length ? (
        <Table variant="card">
          <TableHeader>
            <TableRow>
              {["name", "unique", "origin", "partial", "columns"].map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {indexes.map((index) => (
              <TableRow key={index.name}>
                <TableCell className="font-mono">{index.name}</TableCell>
                <TableCell>{index.isUnique ? "yes" : "no"}</TableCell>
                <TableCell>{index.origin}</TableCell>
                <TableCell>{index.partial ? "yes" : "no"}</TableCell>
                <TableCell className="font-mono">{index.columns.join(", ") || "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyPanel>Индексов нет.</EmptyPanel>
      )}
    </Panel>
  );
}

function RowsPanel({
  columns,
  page,
  pageCount,
  pageSize,
  rowCount,
  rows,
  section,
  sortDirection,
  tableName,
  title = "Строки",
  foreignKeys,
}: {
  columns: string[];
  page: number;
  pageCount: number;
  pageSize: number;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
  section?: SectionName;
  sortDirection: DbSortDirection;
  tableName: string;
  title?: string;
  foreignKeys: DbForeignKey[];
}) {
  const firstRow = rowCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, rowCount);
  const columnWidths = columns.map((column) => compactColumnWidth(column, rows));
  const tableMinWidth = Math.max(
    48,
    columnWidths.reduce((total, width) => total + width, 0),
  );

  return (
    <Panel
      action={<Pagination page={page} pageCount={pageCount} section={section} sortDirection={sortDirection} tableName={tableName} />}
      description={`${firstRow}-${lastRow} из ${rowCount}, страница ${page} из ${pageCount}`}
      title={title}
    >
      <Table className="table-fixed text-xs" style={{ minWidth: `${tableMinWidth}ch` }} variant="card">
        <colgroup>
          {columns.map((column, index) => (
            <col key={column} style={{ width: `${columnWidths[index]}ch` }} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <ColumnHeader key={column} column={column} reference={foreignKeyForColumn(foreignKeys, column)} />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {columns.map((column, columnIndex) => (
                <TableCell key={column} className="!whitespace-normal !p-1.5 !align-top !leading-5 font-mono text-xs">
                  <CompactCell value={row[column]} widthCh={columnWidths[columnIndex]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground" colSpan={Math.max(columns.length, 1)}>
                Нет строк.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </Panel>
  );
}

function CompactCell({ value, widthCh }: { value: unknown; widthCh: number }) {
  const formatted = formatCell(value);
  if (!formatted) return null;

  const textClass = "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]";
  if (!shouldCollapseCell(formatted, widthCh)) return <span className={`block ${textClass}`}>{formatted}</span>;

  return (
    <details className="group min-w-0">
      <summary className={`${textClass} line-clamp-2 cursor-pointer list-none rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 group-open:line-clamp-none [&::-webkit-details-marker]:hidden`}>
        {formatted}
      </summary>
    </details>
  );
}

function compactColumnWidth(column: string, rows: Array<Record<string, unknown>>) {
  const fallback = rows.length ? 0 : Math.min(compactTextWidth(column), 10);
  const dataWidth = rows.reduce((width, row) => Math.max(width, compactTextWidth(formatCell(row[column]))), fallback);
  return Math.min(Math.max(dataWidth + 2, 6), 36);
}

function compactTextWidth(value: string) {
  return value
    .split(/[\s\n]+/)
    .reduce((width, part) => Math.max(width, part.length), 0);
}

function shouldCollapseCell(value: string, widthCh: number) {
  return value.split("\n").length > 2 || value.length > widthCh * 2;
}

function Panel({ action, children, description, title }: { action?: ReactNode; children: ReactNode; description?: string; title: string }) {
  return (
    <CardFrame className="min-w-0">
      <Card>
        <CardHeader className="gap-1.5 p-4 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
          {action ? <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end" data-slot="card-action">{action}</div> : null}
        </CardHeader>
      </Card>
      {children}
    </CardFrame>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="m-0 text-sm text-muted-foreground">{children}</p>
    </Card>
  );
}

function Pagination({
  page,
  pageCount,
  section,
  sortDirection,
  tableName,
}: {
  page: number;
  pageCount: number;
  section?: SectionName;
  sortDirection: DbSortDirection;
  tableName: string;
}) {
  const nextSortDirection = sortDirection === "desc" ? "asc" : "desc";
  const href = (nextPage: number) => databaseHref({ section, table: tableName, tab: "rows", page: nextPage, sort: sortDirection });
  return (
    <nav className="flex flex-wrap items-center justify-end gap-2" aria-label="Пагинация">
      <ButtonLink
        href={databaseHref({ section, table: tableName, tab: "rows", page: 1, sort: nextSortDirection })}
        size="icon-sm"
        title={sortDirection === "desc" ? "Сначала старые" : "Сначала новые"}
        variant="outline"
      >
        <ArrowDownUp className="size-4" />
        <span className="sr-only">{sortDirection === "desc" ? "Сначала старые" : "Сначала новые"}</span>
      </ButtonLink>
      <ButtonLink disabled={page <= 1} href={href(1)} size="icon-sm" variant="outline">
        <ChevronFirst className="size-4" />
        <span className="sr-only">В начало</span>
      </ButtonLink>
      <ButtonLink disabled={page <= 1} href={href(Math.max(1, page - 1))} size="icon-sm" variant="outline">
        <ChevronLeft className="size-4" />
        <span className="sr-only">Назад</span>
      </ButtonLink>
      <Badge className="h-8 px-2" variant="outline">
        {page} / {pageCount}
      </Badge>
      <ButtonLink disabled={page >= pageCount} href={href(Math.min(pageCount, page + 1))} size="icon-sm" variant="outline">
        <ChevronRight className="size-4" />
        <span className="sr-only">Вперёд</span>
      </ButtonLink>
      <ButtonLink disabled={page >= pageCount} href={href(pageCount)} size="icon-sm" variant="outline">
        <ChevronLast className="size-4" />
        <span className="sr-only">В конец</span>
      </ButtonLink>
    </nav>
  );
}

function ColumnHeader({ column, reference }: { column: string; reference: DbForeignKey | undefined }) {
  return (
    <TableHead className="!h-auto !whitespace-normal !px-1.5 !py-2 !align-bottom !leading-4 font-mono text-xs">
      <div className="[overflow-wrap:anywhere]">{column}</div>
      {reference ? <ReferenceLink reference={reference} /> : null}
    </TableHead>
  );
}

function ReferenceLink({ reference }: { reference: DbForeignKey }) {
  return (
    <div className="mt-1 font-sans text-xs font-medium">
      <TableTitleLink tableName={reference.targetTable} title={reference.targetTitle} />
    </div>
  );
}

function TableTitleLink({ tableName, title }: { tableName: string; title: string }) {
  return (
    <Link className="text-primary underline-offset-2 hover:underline visited:text-primary/80" href={databaseHref({ table: tableName, tab: "rows", page: 1 })}>
      {title}
    </Link>
  );
}

function foreignKeyForColumn(foreignKeys: DbForeignKey[], column: string) {
  return foreignKeys.find((key) => key.sourceColumn === column);
}

function parseTab(value: string | undefined): TabName {
  if (value === "relations" || value === "columns" || value === "indexes") return value;
  return "rows";
}

function parseSection(value: string | undefined): SectionName {
  if (value === "schedules") return "schedules";
  if (value === "handlers") return "handlers";
  if (value === "workflows") return "workflows";
  if (value === "role-contracts") return "role-contracts";
  return value === "brai-cmd" ? "brai-cmd" : "database";
}

function fixedSectionTable(section: SectionName) {
  if (section === "handlers") return "handlers";
  if (section === "schedules") return "handler_schedules";
  if (section === "workflows") return "workflow_definitions";
  if (section === "role-contracts") return "role_contracts";
  return undefined;
}

function parseSortDirection(value: string | undefined): DbSortDirection {
  return value === "asc" ? "asc" : "desc";
}

function databaseHref(params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return `/?${search.toString()}`;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
