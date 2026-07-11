export const DATABASE_URL_ENV: string;
export const PAGE_SIZE: number;
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
export function readWorkflowAdminSummary(databaseUrl?: string): Promise<{
  definitions: Array<Record<string, unknown> & { diagramDataUrl: string | null }>;
  executions: Array<Record<string, unknown>>;
}>;
export function readRoleContractsAdmin(databaseUrl?: string): Promise<Array<Record<string, unknown>>>;
export function listTables(db: DbQuery): Promise<DbTable[]>;
export function readColumns(db: DbQuery, tableName: string): Promise<DbColumn[]>;
export function readIndexes(db: DbQuery, tableName: string): Promise<DbIndex[]>;
export function readForeignKeys(db: DbQuery, tableName: string): Promise<DbRawForeignKey[]>;
export function readTableDescriptions(db: DbQuery): Promise<Map<string, DbTableDescription>>;
