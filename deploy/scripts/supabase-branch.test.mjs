import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectOwnedSequences,
  reseedOwnedSequences,
  sequenceAllocationStatus,
  unsafeOwnedSequenceAllocations
} from "./supabase-branch.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("production seed loads only explicitly marked idempotent migrations into the copy transaction", () => {
  const script = fs.readFileSync(path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"), "utf8");
  const migration = fs.readFileSync(
    path.join(repoRoot, "supabase/migrations/0010_agent_role_normalization_workflows.sql"),
    "utf8"
  );
  const seedStart = script.indexOf("async function seedTestDataFromProduction");
  const copyStart = script.indexOf("async function copySchemaData");
  const seedFunction = script.slice(seedStart, copyStart);

  assert.match(migration, /^-- brai:reapply-after-production-seed$/m);
  assert.match(script, /sql\.includes\(POST_PRODUCTION_SEED_MIGRATION_MARKER\)/);
  assert.match(seedFunction, /const postSeedMigrations = postProductionSeedMigrations\(\)/);
  assert.match(seedFunction, /copySchemaData\(pool, \{ sourceSchema, targetSchema, postSeedMigrations \}\)/);
  assert.doesNotMatch(script, /reapplyPostProductionSeedMigrations/);
});

test("production copy reseeds only copied tables before its transaction commits", () => {
  const script = fs.readFileSync(path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"), "utf8");
  const copyStart = script.indexOf("async function copySchemaData");
  const inspectStart = script.indexOf("export async function inspectOwnedSequences");
  const copyFunction = script.slice(copyStart, inspectStart);
  const begin = 'client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")';
  const searchPath = "SET LOCAL search_path TO";
  const reapply = "for (const { sql } of postSeedMigrations) await client.query(sql)";
  const reseed = "reseedOwnedSequences(client, { schema: targetSchema, tables: copyTables })";

  assert.match(copyFunction, /const client = await pool\.connect\(\)/);
  assert.ok(copyFunction.indexOf(begin) > 0);
  assert.ok(copyFunction.indexOf(searchPath) > 0);
  assert.ok(copyFunction.indexOf(reapply) > 0);
  assert.ok(copyFunction.indexOf(reseed) > 0);
  assert.ok(copyFunction.indexOf(begin) < copyFunction.indexOf(searchPath));
  assert.match(copyFunction, /TRUNCATE TABLE .* CONTINUE IDENTITY CASCADE/);
  assert.doesNotMatch(copyFunction, /RESTART IDENTITY/);
  assert.ok(copyFunction.indexOf(searchPath) < copyFunction.indexOf("TRUNCATE TABLE"));
  assert.ok(copyFunction.indexOf(reapply) > copyFunction.indexOf("OVERRIDING SYSTEM VALUE"));
  assert.ok(copyFunction.indexOf(reapply) < copyFunction.indexOf(reseed));
  assert.ok(copyFunction.indexOf(reseed) > copyFunction.indexOf("OVERRIDING SYSTEM VALUE"));
  assert.ok(copyFunction.indexOf(reseed) < copyFunction.indexOf('client.query("COMMIT")'));
  assert.doesNotMatch(copyFunction, /tables: truncatableTables/);
});

test("Postgres smoke inspects owned sequences on one repeatable-read client under SHARE locks", () => {
  const smoke = fs.readFileSync(path.join(repoRoot, "deploy/scripts/postgres-smoke.mjs"), "utf8");
  const connectIndex = smoke.indexOf("const sequenceClient = await pool.connect()");
  const beginIndex = smoke.indexOf('sequenceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ")');
  const inspectIndex = smoke.indexOf("inspectOwnedSequences(sequenceClient");
  const commitIndex = smoke.indexOf('sequenceClient.query("COMMIT")');
  const releaseIndex = smoke.indexOf("sequenceClient.release()");

  assert.ok(connectIndex > 0);
  assert.ok(connectIndex < beginIndex);
  assert.ok(beginIndex < inspectIndex);
  assert.ok(inspectIndex < commitIndex);
  assert.ok(commitIndex < releaseIndex);
  assert.match(smoke, /lockOwnedTables: true/);
});

test("owned sequence inspection SHARE-locks quoted tables before reading allocation state", async () => {
  const metadata = [sequence('owned "table"', 'owned "sequence"', true, {
    sequence_schema: 'preview "schema"'
  })];
  const queries = [];
  const queryable = {
    async query(sql) {
      queries.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("FROM information_schema.columns target")) return { rows: metadata };
      if (sql.includes("LOCK TABLE")) return { rows: [] };
      if (sql.includes("SELECT last_value::text")) return { rows: [{ last_value: "1", is_called: false }] };
      if (sql.includes("MIN(")) return { rows: [{ min_value: null, max_value: null }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  await inspectOwnedSequences(queryable, {
    schema: 'preview "schema"',
    lockOwnedTables: true
  });

  const lockIndex = queries.findIndex((sql) => sql.startsWith("LOCK TABLE"));
  const stateIndex = queries.findIndex((sql) => sql.startsWith("SELECT last_value"));
  assert.ok(lockIndex > 0);
  assert.ok(lockIndex < stateIndex);
  assert.equal(queries[lockIndex], 'LOCK TABLE "preview ""schema"""."owned ""table""" IN SHARE MODE');
});

test("owned serial and identity sequences advance without touching empty, preserved, or already-ahead allocation", async () => {
  const copiedTables = ["copied_serial", "copied_identity", "empty_table", "ahead_table"];
  const metadata = [
    sequence("copied_serial", "copied_serial_id_seq", false),
    sequence("copied_identity", "copied_identity_id_seq", true, { start_value: "100" }),
    sequence("empty_table", "empty_table_id_seq", true, { start_value: "10" }),
    sequence("ahead_table", "ahead_table_id_seq", false)
  ];
  const states = {
    copied_serial_id_seq: { last_value: "1", is_called: false },
    copied_identity_id_seq: { last_value: "100", is_called: false },
    empty_table_id_seq: { last_value: "10", is_called: false },
    ahead_table_id_seq: { last_value: "500", is_called: true }
  };
  const values = {
    copied_serial: { min_value: "1", max_value: "42" },
    copied_identity: { min_value: "100", max_value: "107" },
    empty_table: { min_value: null, max_value: null },
    ahead_table: { min_value: "1", max_value: "100" }
  };
  const restartCalls = [];
  const queryable = {
    async query(sql, params = []) {
      if (sql.includes("FROM information_schema.columns target")) {
        assert.deepEqual(params, ["preview", copiedTables]);
        assert.match(sql, /pg_get_serial_sequence/);
        assert.doesNotMatch(params[1].join(","), /preserved_table/);
        return { rows: metadata };
      }
      if (sql.includes("SELECT last_value::text")) {
        const name = Object.keys(states).find((candidate) => sql.includes(`\"${candidate}\"`));
        return { rows: [states[name]] };
      }
      if (sql.includes("MIN(\"id\")")) {
        const table = Object.keys(values).find((candidate) => sql.includes(`\"${candidate}\"`));
        return { rows: [values[table]] };
      }
      if (sql.includes("ALTER SEQUENCE")) {
        restartCalls.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [{}] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const inspected = await inspectOwnedSequences(queryable, { schema: "preview", tables: copiedTables });
  assert.deepEqual(
    unsafeOwnedSequenceAllocations(inspected).map((entry) => entry.table_name),
    ["copied_serial", "copied_identity"]
  );

  const reseeded = await reseedOwnedSequences(queryable, { schema: "preview", tables: copiedTables });
  assert.deepEqual(reseeded.map((entry) => entry.table_name), ["copied_serial", "copied_identity"]);
  assert.deepEqual(restartCalls, [
    'ALTER SEQUENCE "preview"."copied_serial_id_seq" RESTART WITH 43',
    'ALTER SEQUENCE "preview"."copied_identity_id_seq" RESTART WITH 108'
  ]);
  assert.equal(sequenceAllocationStatus(inspected[2]).reason, "empty");
  assert.equal(sequenceAllocationStatus(inspected[2]).nextValue, 10n);
  assert.equal(sequenceAllocationStatus(inspected[3]).reason, "ahead");
  assert.equal(sequenceAllocationStatus(inspected[3]).nextValue, 501n);
});

test("empty tables still fail readiness when a non-cycling sequence is exhausted", () => {
  const exhausted = sequence("empty_table", "empty_table_id_seq", true, {
    last_value: "10",
    is_called: true,
    min_value: null,
    max_value: null,
    min_limit: "1",
    max_limit: "10"
  });
  const cycling = { ...exhausted, cycles: true };

  assert.deepEqual(sequenceAllocationStatus(exhausted), {
    safe: false,
    reason: "exhausted",
    nextValue: 11n,
    boundary: null
  });
  assert.deepEqual(sequenceAllocationStatus(cycling), {
    safe: true,
    reason: "empty",
    nextValue: 1n
  });
});

test("reseed repairs ascending, descending, and empty exhausted owned sequences", async () => {
  const metadata = [
    sequence("ascending_exhausted", "ascending_exhausted_id_seq", true, {
      max_limit: "100"
    }),
    sequence("descending_collision", "descending_collision_id_seq", false, {
      start_value: "-1",
      increment: "-2",
      min_limit: "-100",
      max_limit: "-1"
    }),
    sequence("empty_exhausted", "empty_exhausted_id_seq", true, {
      start_value: "7",
      min_limit: "1",
      max_limit: "10"
    })
  ];
  const fixture = sequenceFixture(metadata, {
    ascending_exhausted_id_seq: { last_value: "100", is_called: true },
    descending_collision_id_seq: { last_value: "-1", is_called: false },
    empty_exhausted_id_seq: { last_value: "10", is_called: true }
  }, {
    ascending_exhausted: { min_value: "1", max_value: "42" },
    descending_collision: { min_value: "-43", max_value: "-1" },
    empty_exhausted: { min_value: null, max_value: null }
  });

  const reseeded = await reseedOwnedSequences(fixture.queryable, {
    schema: "preview",
    tables: metadata.map((entry) => entry.table_name)
  });

  assert.deepEqual(reseeded.map((entry) => entry.table_name), [
    "ascending_exhausted",
    "descending_collision",
    "empty_exhausted"
  ]);
  assert.deepEqual(fixture.restartCalls, [
    'ALTER SEQUENCE "preview"."ascending_exhausted_id_seq" RESTART WITH 43',
    'ALTER SEQUENCE "preview"."descending_collision_id_seq" RESTART WITH -45',
    'ALTER SEQUENCE "preview"."empty_exhausted_id_seq" RESTART WITH 7'
  ]);
});

test("non-empty cycling, cached, and irreparably exhausted sequences fail closed", async () => {
  const cycling = sequence("cycling_table", "cycling_table_id_seq", true, {
    cycles: true,
    last_value: "5",
    is_called: true,
    min_value: "1",
    max_value: "5"
  });
  const cached = { ...cycling, cycles: false, cache_size: "10" };

  assert.equal(sequenceAllocationStatus(cycling).reason, "cycling");
  assert.equal(sequenceAllocationStatus(cached).reason, "cached");

  for (const [entry, reason] of [[cycling, "cycling"], [cached, "cached"]]) {
    const fixture = sequenceFixture([entry], {
      [entry.sequence_name]: { last_value: entry.last_value, is_called: entry.is_called }
    }, {
      [entry.table_name]: { min_value: entry.min_value, max_value: entry.max_value }
    });
    await assert.rejects(
      reseedOwnedSequences(fixture.queryable, { schema: "preview", tables: [entry.table_name] }),
      new RegExp(reason)
    );
  }

  const irreparable = sequence("full_table", "full_table_id_seq", true, {
    max_limit: "10"
  });
  const full = sequenceFixture([irreparable], {
    full_table_id_seq: { last_value: "10", is_called: true }
  }, {
    full_table: { min_value: "1", max_value: "10" }
  });
  await assert.rejects(
    reseedOwnedSequences(full.queryable, { schema: "preview", tables: ["full_table"] }),
    /Cannot reseed exhausted sequence/
  );
});

test("workflow diagram seed stores real newlines for Kroki", () => {
  const migration = fs.readFileSync(
    path.join(repoRoot, "supabase/migrations/0010_agent_role_normalization_workflows.sql"),
    "utf8"
  );

  assert.ok(migration.includes("$mermaid$flowchart LR\n"));
  assert.equal(migration.includes("flowchart LR\\n"), false);
});

test("preview env setup rewrites existing shell-unsafe values safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-env-"));
  const envFile = path.join(dir, "brai-api.env");
  fs.writeFileSync(envFile, [
    "BRAI_AUTH_FROM=Brai <auth@mail.brai.one>",
    "BRAI_DATA_STORE=sqlite",
    "BRAI_LEGACY_SQLITE_PATH=/srv/projects/brai/data/brai.sqlite",
    "BRAI_TEST_AUTO_LOGIN=true",
    "BRAI_SESSION_SECRET=old-auto-login-secret",
    "BROKEN NON ASSIGNMENT",
    ""
  ].join("\n"));
  const env = {
    ...process.env,
    BRAI_SUPABASE_DRY_RUN: "true",
    BRAI_ENVS_ROOT: dir,
    BRAI_PREVIEW_REGISTRY: path.join(dir, "preview-slots.json"),
    BRAI_PREVIEW_LOCK: path.join(dir, "preview-slots.lock"),
    NODE_BIN: process.execPath,
    SUPABASE_SELF_HOSTED: "true",
    SUPABASE_SELF_HOSTED_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai"
  };

  const allocation = spawnSync("bash", [
    path.join(repoRoot, "deploy/scripts/preview-slots.sh"),
    "allocate",
    "codex/supabase-only-runtime",
    "test-commit"
  ], { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(allocation.status, 0, allocation.stderr || allocation.stdout);

  const result = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const source = spawnSync("bash", ["-n", envFile], { encoding: "utf8" });
  assert.equal(source.status, 0, source.stderr || source.stdout);
  const contents = fs.readFileSync(envFile, "utf8");
  assert.match(contents, /^BRAI_AUTH_FROM='Brai <auth@mail\.brai\.one>'$/m);
  assert.doesNotMatch(contents, /BRAI_DATA_STORE|BRAI_LEGACY_SQLITE_PATH|BROKEN NON ASSIGNMENT/);
  assert.match(contents, /^BRAI_DATABASE_URL='postgres:\/\/brai:brai@127\.0\.0\.1:5432\/brai\?options=-c\+search_path%3Dbrai_preview_supabase_only_runtime_e3117d5f%2Cpublic'$/m);
  assert.match(contents, /^BRAI_SUPABASE_BRANCH='brai_preview_supabase_only_runtime_e3117d5f'$/m);
  assert.match(contents, /^BRAI_TEST_EMAIL_LOGIN='true'$/m);
  assert.doesNotMatch(contents, /BRAI_TEST_AUTO_LOGIN/);
  assert.match(contents, /^BRAI_SESSION_SECRET='[^']{32,}'$/m);
  assert.doesNotMatch(contents, /old-auto-login-secret/);
});

test("dev env setup enables explicit test email login", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-dev-env-"));
  const envFile = path.join(dir, "brai-api.env");
  const result = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "dev-env",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      BRAI_SUPABASE_DRY_RUN: "true",
      SUPABASE_SELF_HOSTED: "true",
      SUPABASE_SELF_HOSTED_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai"
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const contents = fs.readFileSync(envFile, "utf8");
  assert.match(contents, /^BRAI_SUPABASE_BRANCH='brai_dev'$/m);
  assert.match(contents, /^BRAI_TEST_EMAIL_LOGIN='true'$/m);
  assert.doesNotMatch(contents, /BRAI_TEST_AUTO_LOGIN/);
});

test("branch database URL override requires explicit preview marker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-override-"));
  const envFile = path.join(dir, "brai-api.env");
  const baseEnv = {
    ...process.env,
    BRAI_SUPABASE_DRY_RUN: "true",
    BRAI_ENVS_ROOT: dir,
    BRAI_PREVIEW_REGISTRY: path.join(dir, "preview-slots.json"),
    BRAI_PREVIEW_LOCK: path.join(dir, "preview-slots.lock"),
    NODE_BIN: process.execPath,
    SUPABASE_PROJECT_REF: "dry-run-project",
    SUPABASE_BRANCH_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai"
  };

  const denied = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: baseEnv
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE=true/);

  const wrongMarker = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...baseEnv,
      BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE: "true"
    }
  });
  assert.notEqual(wrongMarker.status, 0);
  assert.match(wrongMarker.stderr, /expected branch\/schema marker/);

  const allocation = spawnSync("bash", [
    path.join(repoRoot, "deploy/scripts/preview-slots.sh"),
    "allocate",
    "codex/supabase-only-runtime",
    "test-commit"
  ], { cwd: repoRoot, encoding: "utf8", env: baseEnv });
  assert.equal(allocation.status, 0, allocation.stderr || allocation.stdout);

  const allowed = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...baseEnv,
      BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE: "true",
      SUPABASE_BRANCH_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai?options=-c%20search_path%3Dbrai-preview-supabase-only-runtime-e3117d5f"
    }
  });
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
});

function sequence(tableName, sequenceName, isIdentity, overrides = {}) {
  return {
    table_name: tableName,
    column_name: "id",
    sequence_schema: "preview",
    sequence_name: sequenceName,
    start_value: "1",
    increment: "1",
    min_limit: "1",
    max_limit: "2147483647",
    cache_size: "1",
    cycles: false,
    is_identity: isIdentity,
    ...overrides
  };
}

function sequenceFixture(metadata, states, values) {
  const restartCalls = [];
  const queryable = {
    async query(sql) {
      if (sql.includes("FROM information_schema.columns target")) return { rows: metadata };
      if (sql.includes("SELECT last_value::text")) {
        const entry = metadata.find((candidate) => sql.includes(quoted(candidate.sequence_name)));
        return { rows: [states[entry.sequence_name]] };
      }
      if (sql.includes("MIN(")) {
        const entry = metadata.find((candidate) => sql.includes(quoted(candidate.table_name)));
        return { rows: [values[entry.table_name]] };
      }
      if (sql.includes("ALTER SEQUENCE")) {
        restartCalls.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [{}] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return { queryable, restartCalls };
}

function quoted(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
