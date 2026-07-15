import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDatabaseUrlTenant,
  databaseUrlForSupavisorTenant,
  rewriteEnvDatabaseUrl,
  upsertEnvValue,
} from "./supavisor-tenants.mjs";

test("tenant rewrite changes only the Supavisor tenant", () => {
  const source = new URL("postgres://postgres.brightos:p%40ss@127.0.0.1:55432/postgres?sslmode=disable&options=-c%20search_path%3Dbrai_preview_x%2Cpublic");
  const rewritten = new URL(databaseUrlForSupavisorTenant(source.toString(), "brightos-nonprod"));

  assert.equal(rewritten.username, "postgres.brightos-nonprod");
  assert.equal(rewritten.password, source.password);
  assert.equal(rewritten.host, source.host);
  assert.equal(rewritten.pathname, source.pathname);
  assert.equal(rewritten.searchParams.get("options"), source.searchParams.get("options"));
  assert.equal(rewritten.searchParams.get("sslmode"), source.searchParams.get("sslmode"));
});

test("tenant assertion is staged and then fail-closed by environment", () => {
  const legacy = "postgres://postgres.brightos:secret@127.0.0.1:55432/postgres";
  assert.doesNotThrow(() => assertDatabaseUrlTenant(legacy, "prod", {}));
  assert.throws(
    () => assertDatabaseUrlTenant(legacy, "prod", { BRAI_SUPAVISOR_TENANT_ISOLATION: "true" }),
    /brightos-prod/,
  );
  assert.doesNotThrow(() => assertDatabaseUrlTenant(
    "postgres://postgres.brightos-prod:secret@127.0.0.1:55432/postgres",
    "prod",
    { BRAI_SUPAVISOR_TENANT_ISOLATION: "true" },
  ));
  assert.throws(
    () => assertDatabaseUrlTenant(
      "postgres://postgres.brightos-prod:secret@127.0.0.1:55432/postgres",
      "preview-a",
      { BRAI_SUPAVISOR_TENANT_ISOLATION: "true" },
    ),
    /brightos-nonprod/,
  );
});

test("environment rewrite preserves unrelated settings and file ownership mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supavisor-tenant-"));
  const envFile = path.join(dir, "brai-api.env");
  fs.writeFileSync(envFile, [
    "KEEP_ME='yes'",
    "BRAI_DATABASE_URL='postgres://postgres.brightos:secret@127.0.0.1:55432/postgres?options=-c%20search_path%3Dbrai_dev%2Cpublic'",
    "",
  ].join("\n"), { mode: 0o660 });
  const originalMode = fs.statSync(envFile).mode & 0o777;

  assert.equal(rewriteEnvDatabaseUrl(envFile, { tenant: "brightos-nonprod" }), true);
  const contents = fs.readFileSync(envFile, "utf8");
  assert.match(contents, /^KEEP_ME='yes'$/m);
  assert.match(contents, /postgres\.brightos-nonprod/);
  assert.match(contents, /search_path%3Dbrai_dev%2Cpublic/);
  assert.equal(fs.statSync(envFile).mode & 0o777, originalMode);

  upsertEnvValue(envFile, "BRAI_SUPAVISOR_TENANT_ISOLATION", "true");
  upsertEnvValue(envFile, "BRAI_SUPAVISOR_TENANT_ISOLATION", "true");
  assert.equal(fs.readFileSync(envFile, "utf8").match(/BRAI_SUPAVISOR_TENANT_ISOLATION/g)?.length, 1);
});
