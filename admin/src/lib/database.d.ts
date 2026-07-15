export const DATABASE_URL_ENV: string;
export const PAGE_SIZE: number;
export const WORKFLOW_RUN_PAGE_SIZE: number;
export const DEFAULT_SORT_DIRECTION: DbSortDirection;
export type DbSortDirection = "asc" | "desc";
export type DbTableGroup = "user" | "system";

export type DbTable = {
  name: string;
  type: string;
  group: DbTableGroup;
  rowCount: number;
  description: DbTableDescription | null;
};

export type DbTableDescription = {
  table_name: string;
  title: string;
  short_description: string;
  long_description: string;
};

export type DbColumn = {
  cid: number;
  name: string;
  type: string;
  isNotNull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
};

export type DbIndex = {
  name: string;
  isUnique: number;
  origin: string;
  partial: number;
  columns: string[];
};

export type DbForeignKey = {
  id: number;
  seq: number;
  targetTable: string;
  targetTitle: string;
  sourceColumn: string;
  targetColumn: string;
  on_update: string;
  on_delete: string;
  match: string;
};

export type DbRawForeignKey = Omit<DbForeignKey, "targetTitle">;

export type DbIncomingForeignKey = DbForeignKey & {
  sourceTable: string;
  sourceTitle: string;
};

export type DbStats = {
  databaseName: string;
  schemaName: string;
  databaseSizeBytes: number;
  tableCount: number;
  totalRows: number;
};

export type DbView = {
  stats: DbStats;
  tables: DbTable[];
  selectedTable: DbTable | null;
  tableDescription: DbTableDescription | null;
  columns: DbColumn[];
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
  referencedBy: DbIncomingForeignKey[];
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  pageCount: number;
  rowCount: number;
};

export type DbQuery = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type DbPool = DbQuery & {
  connect(): Promise<DbQuery & { release(): void }>;
  close(): Promise<void>;
};

export type AdminDiagram = { source: string; dataUrl: string | null };
export type AdminWorkflowProcess = {
  lanes?: Array<{ id?: string; label?: string }>;
  steps?: Array<{
    id?: string;
    label?: string;
    lane?: string;
    kind?: string;
    owner?: string;
    agent_id?: string;
    reads?: string[];
    writes?: string[];
    transaction?: string | null;
  }>;
  edges?: Array<{ from?: string; to?: string; kind?: string; condition?: string }>;
  terminals?: Array<{ id?: string; status?: string }>;
};
export type AdminJsonSchema = {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};
export type RoleContractAdminSummary = {
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
  inputSchema: AdminJsonSchema;
  outputSchema: AdminJsonSchema;
  dataLinks: Array<{
    table: string;
    column: string;
    fk: string;
    cardinality: string;
    nullable: string;
    mutationOwner: string;
    createdWhen: string;
    softDelete: string;
  }>;
  diagnostics: Array<{ name: string; status: "healthy" | "warning" | "broken"; reason: string }>;
  health: "healthy" | "warning" | "broken";
  healthReason: string;
  rawDefinition: Record<string, unknown>;
  diagrams: { data: AdminDiagram; lifecycle: AdminDiagram };
};
export type WorkflowAdminSummary = {
  id: string;
  version: number;
  title: string;
  description: string;
  status: string;
  taskQueue: string;
  steps: string[];
  process: AdminWorkflowProcess;
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
  health: "healthy" | "degraded" | "broken";
  healthReason: string;
  diagrams?: Record<"orchestration" | "data" | "errors", AdminDiagram>;
};
export type WorkflowExecutionAdminSummary = {
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
export type WorkflowExecutionAdminDetail = WorkflowExecutionAdminSummary & {
  steps: Array<Record<string, unknown>>;
  aiLogs: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  diagram?: AdminDiagram;
};

export function resolveDatabaseUrl(): string;
export function quoteIdentifier(name: string): string;
export function classifyTableGroup(tableName: string): DbTableGroup;
export function openReadOnlyDatabase(databaseUrl?: string): DbPool;
export function readDatabaseView(options?: {
  databaseUrl?: string;
  tableName?: string;
  page?: number;
  pageSize?: number;
  sortDirection?: DbSortDirection;
}): Promise<DbView>;
export function readPrimaryUserId(databaseUrl?: string): Promise<string | null>;
export function readWorkflowAdminSummary(options?: string | {
  databaseUrl?: string;
  workflowId?: string;
  version?: number;
  runId?: string;
  cursor?: string;
  status?: string;
  role?: string;
  owner?: string;
  health?: string;
  stuck?: string;
  hasError?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{
  workflows: WorkflowAdminSummary[];
  selectedWorkflow: WorkflowAdminSummary | null;
  runs: { rows: WorkflowExecutionAdminSummary[]; nextCursor: string | null; pageSize: number };
  selectedExecution: WorkflowExecutionAdminDetail | null;
  definitions: WorkflowAdminSummary[];
  executions: WorkflowExecutionAdminSummary[];
}>;
export function readRoleContractsAdmin(options?: string | {
  databaseUrl?: string;
  roleId?: string;
}): Promise<{
  roles: RoleContractAdminSummary[];
  selectedRole: RoleContractAdminSummary | null;
  rows: RoleContractAdminSummary[];
}>;
export function listTables(db: DbQuery): Promise<DbTable[]>;
export function readColumns(db: DbQuery, tableName: string): Promise<DbColumn[]>;
export function readIndexes(db: DbQuery, tableName: string): Promise<DbIndex[]>;
export function readForeignKeys(db: DbQuery, tableName: string): Promise<DbRawForeignKey[]>;
export function readTableDescriptions(db: DbQuery): Promise<Map<string, DbTableDescription>>;
