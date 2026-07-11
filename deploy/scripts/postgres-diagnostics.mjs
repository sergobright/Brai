#!/usr/bin/env node
import { createRequire } from "node:module";

const root = process.env.BRAI_ROOT ?? new URL("../..", import.meta.url).pathname;
const require = createRequire(`${root}/services/brai_api/package.json`);
const { Pool } = require("pg");
const databaseUrl = process.env.BRAI_DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//.test(databaseUrl ?? "")) throw new Error("BRAI_DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, ssl: /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false });
try {
  const summary = await pool.query(`
    SELECT current_database() AS database,
      current_setting('max_connections')::int AS max_connections,
      current_setting('superuser_reserved_connections')::int AS reserved_connections,
      (SELECT count(*)::int FROM pg_stat_activity) AS total_connections
  `);
  const activity = await pool.query(`
    SELECT coalesce(datname, '<system>') AS database,
      coalesce(application_name, '<unset>') AS application,
      coalesce(state, '<system>') AS state,
      count(*)::int AS connections
    FROM pg_stat_activity
    GROUP BY datname, application_name, state
    ORDER BY connections DESC, database, application
  `);
  console.log(JSON.stringify({ summary: summary.rows[0], activity: activity.rows }, null, 2));
} finally {
  await pool.end();
}
