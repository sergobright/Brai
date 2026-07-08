import pg from "pg";

const { Pool } = pg;

export const DATABASE_URL_ENV = "BRAI_DATABASE_URL";
export const PAGE_SIZE = 50;
export const DEFAULT_SORT_DIRECTION = "desc";
const CREATED_COLUMN_NAMES = ["created_at_utc", "created_at", "createdAt", "created_on", "creation_date"];
const USER_TABLE_NAMES = new Set(["activities", "app_settings", "inbox"]);
const USER_TABLE_PREFIXES = ["activity_", "focus_", "timer_"];
const SYSTEM_TABLE_NAMES = new Set(["items", "logs"]);
const SYSTEM_TABLE_PREFIXES = ["schema_", "table_", "build_", "deployment_", "version_", "agent_", "ai_", "brai_cmd_"];
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

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

export function openReadOnlyDatabase(databaseUrl = resolveDatabaseUrl()) {
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
