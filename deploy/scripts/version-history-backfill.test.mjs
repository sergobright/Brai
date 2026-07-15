import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createTestDatabase } from "../../services/brai_api/test-support/api.js";
import {
  applyVersionHistoryBackfill,
  buildReport,
  validateManifest
} from "./version-history-backfill.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");
const manifestPath = path.join(root, "supabase/backfills/version-history-20260714.json");
const reportPath = path.join(root, "supabase/backfills/version-history-20260714-report.json");

test("checked-in cutoff manifest and report are deterministic and complete", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  assert.doesNotThrow(() => validateManifest(manifest));
  assert.deepEqual(buildReport(manifest), report);
  assert.deepEqual(report.counts.versions_by_type, { apk: 11, build: 145 });
  assert.equal(report.counts.versions, 156);
  assert.equal(report.counts.merged_pull_requests_imported, 277);
  assert.equal(report.counts.details, 240);
  assert.equal(report.counts.imported_but_unlinked_pull_requests, 155);
  assert.equal(report.counts.versions_without_pull_requests, 24);
  assert.doesNotMatch(JSON.stringify(manifest), /\/(?:srv|home|tmp|etc|var|opt|run)\//);
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(['Ser', 'gey'].join(''), 'i'));
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(['Сер', 'гей'].join(''), 'iu'));

  const apk11 = manifest.versions.find((version) => version.version_type_id === "apk" && version.version === 11);
  assert.deepEqual(apk11.pull_requests, [{ repository: "sergobright/Brai", pull_number: 279 }]);
  assert.equal(apk11.details.length, 5);
  assert.equal(apk11.details.every((detail) => detail.pull_number === 279), true);
  assert.equal(apk11.refs[0].target_commit, "3e30f42f7d2d35a7865b425dfa116a58d816a92f");
  assert.equal(manifest.corrections[0].from_pull_number, 282);
  assert.equal(manifest.corrections[0].evidence.artifact.embedded_build, "0.0.142");

  const unsafe = structuredClone(manifest);
  unsafe.pull_requests[0].body += "\nAuthorization: Basic dXNlcjpwYXNz";
  assert.throws(() => validateManifest(unsafe), /private runtime data/);
});

test("backfill keeps identities stable on the second run and rolls back atomically", {
  skip: !process.env.BRAI_TEST_DATABASE_URL
}, async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await seedVersion(pool, 901, "2026-07-14T10:00:00.000Z");
    const wrongRef = await pool.query(`
      INSERT INTO build_version_refs (
        version_type_id, version, source_branch, source_commit, target_branch, target_commit, created_at_utc
      ) VALUES ('build', 901, 'codex/old', 'old-head', 'main', 'old-merge', '2026-07-14T10:01:00.000Z')
      RETURNING id
    `);
    const manifest = fixtureManifest(901);

    const firstReport = await applyVersionHistoryBackfill(pool, manifest);
    const firstRows = await normalizedRows(pool);
    assert.equal(firstRows.refs[0].id, wrongRef.rows[0].id);
    assert.equal(firstRows.refs[0].target_commit, "merge-501");

    const secondReport = await applyVersionHistoryBackfill(pool, manifest);
    const secondRows = await normalizedRows(pool);
    assert.deepEqual(secondRows, firstRows);
    assert.deepEqual(secondReport, firstReport);
    assert.equal(secondRows.details.length, 2);
    assert.equal(secondRows.links.length, 1);

    await seedVersion(pool, 902, "2026-07-14T11:00:00.000Z");
    const rollbackManifest = fixtureManifest(902, 502);
    await assert.rejects(
      applyVersionHistoryBackfill(pool, rollbackManifest, {
        beforeCommit: async () => { throw new Error("forced rollback"); }
      }),
      /forced rollback/
    );
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM release_works WHERE work_key='legacy:pr:sergobright/Brai:502'")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT release_works_id FROM build_versions WHERE version_type_id='build' AND version=902")).rows[0].release_works_id, null);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM build_version_details AS details
      JOIN build_versions AS versions ON versions.id=details.build_versions_id
      WHERE versions.version_type_id='build' AND versions.version=902
    `)).rows[0].count, 0);

    const empty = structuredClone(rollbackManifest);
    empty.versions[0].details = [];
    assert.throws(() => validateManifest(empty), /requires at least one detail/);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test("full 156-version/277-PR cutoff backfill is identical on its second run", {
  skip: !process.env.BRAI_TEST_DATABASE_URL
}, async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      TRUNCATE TABLE
        build_version_pull_requests,
        build_version_details,
        github_pull_requests,
        release_works,
        build_version_refs,
        build_versions
      RESTART IDENTITY CASCADE
    `);
    for (const version of manifest.versions) {
      await pool.query(`
        INSERT INTO build_versions (
          version_type_id, version, short_changes, detailed_changes, reason, released_at_utc, created_at_utc
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [
        version.version_type_id,
        version.version,
        version.parent.short_changes,
        version.parent.detailed_changes,
        version.parent.reason,
        version.parent.released_at_utc,
        version.parent.created_at_utc
      ]);
      for (const ref of version.refs) {
        const apk11 = version.version_type_id === "apk" && version.version === 11;
        await pool.query(`
          INSERT INTO build_version_refs (
            version_type_id, version, source_branch, source_commit, target_branch, target_commit, created_at_utc
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [
          version.version_type_id,
          version.version,
          apk11 ? null : ref.source_branch,
          apk11 ? null : ref.source_commit,
          ref.target_branch,
          apk11 ? manifest.corrections[0].from_target_commit : ref.target_commit,
          ref.created_at_utc
        ]);
      }
    }
    await seedVersion(pool, 146, "2026-07-14T23:59:00.000Z");

    const firstReport = await applyVersionHistoryBackfill(pool, manifest);
    const firstIdentity = await identityDigest(pool);
    const secondReport = await applyVersionHistoryBackfill(pool, manifest);
    const secondIdentity = await identityDigest(pool);
    assert.deepEqual(secondReport, firstReport);
    assert.deepEqual(secondIdentity, firstIdentity);
    assert.deepEqual(firstIdentity.counts, {
      details: 241,
      links: 132,
      pulls: 277,
      refs: 133,
      versions: 157,
      works: 277
    });
    const postCutoff = await pool.query(`
      SELECT details.title, details.description, details.github_pull_requests_id
      FROM build_version_details AS details
      JOIN build_versions AS versions ON versions.id=details.build_versions_id
      WHERE versions.version_type_id='build' AND versions.version=146
    `);
    assert.deepEqual(postCutoff.rows, [{
      title: "Short 146",
      description: "Detailed 146",
      github_pull_requests_id: null
    }]);
    const apk11 = await pool.query(`
      SELECT pulls.pull_number, refs.target_commit
      FROM build_versions AS versions
      JOIN build_version_pull_requests AS links ON links.build_versions_id=versions.id
      JOIN github_pull_requests AS pulls ON pulls.id=links.github_pull_requests_id
      JOIN build_version_refs AS refs
        ON refs.version_type_id=versions.version_type_id AND refs.version=versions.version
      WHERE versions.version_type_id='apk' AND versions.version=11
    `);
    assert.deepEqual(apk11.rows, [{
      pull_number: 279,
      target_commit: "3e30f42f7d2d35a7865b425dfa116a58d816a92f"
    }]);
  } finally {
    await pool.end();
    await database.drop();
  }
});

async function seedVersion(pool, version, timestamp) {
  await pool.query(`
    INSERT INTO build_versions (
      version_type_id, version, short_changes, detailed_changes, reason, released_at_utc, created_at_utc
    ) VALUES ('build', $1, $2, $3, $4, $5, $5)
  `, [version, `Short ${version}`, `Detailed ${version}`, `Reason ${version}`, timestamp]);
}

function fixtureManifest(version, pullNumber = 501) {
  const releasedAtUtc = version === 901 ? "2026-07-14T10:00:00.000Z" : "2026-07-14T11:00:00.000Z";
  const workKey = `legacy:pr:sergobright/Brai:${pullNumber}`;
  return {
    schema_version: 1,
    cutoff: {},
    evidence_policy: {},
    release_works: [{
      work_key: workKey,
      status: "finalized",
      created_at_utc: "2026-07-14T09:00:00.000Z",
      updated_at_utc: releasedAtUtc,
      finalized_at_utc: releasedAtUtc
    }],
    pull_requests: [{
      work_key: workKey,
      work_role: "owner",
      repository: "sergobright/Brai",
      pull_number: pullNumber,
      url: `https://github.com/sergobright/Brai/pull/${pullNumber}`,
      title: `PR ${pullNumber}`,
      body: `Public body ${pullNumber}`,
      author_login: "sergobright",
      state: "CLOSED",
      is_draft: false,
      head_branch: `codex/work-${pullNumber}`,
      base_branch: "main",
      merge_commit_sha: `merge-${pullNumber}`,
      github_created_at_utc: "2026-07-14T09:00:00.000Z",
      github_updated_at_utc: releasedAtUtc,
      github_closed_at_utc: releasedAtUtc,
      github_merged_at_utc: releasedAtUtc,
      created_at_utc: "2026-07-14T09:00:00.000Z",
      updated_at_utc: releasedAtUtc
    }],
    versions: [{
      version_type_id: "build",
      version,
      release_work_key: workKey,
      parent: {
        included_in_version: null,
        short_changes: `Short ${version}`,
        detailed_changes: `Detailed ${version}`,
        reason: `Reason ${version}`,
        released_at_utc: releasedAtUtc,
        created_at_utc: releasedAtUtc
      },
      details: [
        { title: "First", description: "First atomic change.", pull_number: pullNumber },
        { title: "Second", description: "Second atomic change.", pull_number: pullNumber }
      ],
      pull_requests: [{ repository: "sergobright/Brai", pull_number: pullNumber }],
      refs: [{
        source_branch: `codex/work-${pullNumber}`,
        source_commit: `head-${pullNumber}`,
        target_branch: "main",
        target_commit: `merge-${pullNumber}`,
        created_at_utc: releasedAtUtc
      }]
    }],
    corrections: [],
    versions_without_pull_requests: [],
    imported_but_unlinked_pull_requests: [],
    insufficient_evidence: []
  };
}

async function normalizedRows(pool) {
  const queries = await Promise.all([
    pool.query("SELECT id, work_key, status, finalized_at_utc FROM release_works ORDER BY id"),
    pool.query("SELECT id, release_works_id, pull_number, merge_commit_sha FROM github_pull_requests ORDER BY id"),
    pool.query("SELECT id, release_works_id, version_type_id, version, short_changes FROM build_versions WHERE version=901 ORDER BY id"),
    pool.query(`
      SELECT details.id, details.build_versions_id, details.github_pull_requests_id,
        details.title, details.description, details.display_order
      FROM build_version_details AS details
      JOIN build_versions AS versions ON versions.id=details.build_versions_id
      WHERE versions.version_type_id='build' AND versions.version=901
      ORDER BY details.id
    `),
    pool.query("SELECT build_versions_id, version_type_id, github_pull_requests_id FROM build_version_pull_requests ORDER BY build_versions_id"),
    pool.query("SELECT id, version_type_id, version, source_branch, source_commit, target_branch, target_commit FROM build_version_refs ORDER BY id")
  ]);
  const [works, pulls, versions, details, links, refs] = queries.map((result) => result.rows);
  return { works, pulls, versions, details, links, refs };
}

async function identityDigest(pool) {
  const tables = {
    works: "release_works",
    pulls: "github_pull_requests",
    versions: "build_versions",
    details: "build_version_details",
    links: "build_version_pull_requests",
    refs: "build_version_refs"
  };
  const counts = {};
  const identities = {};
  for (const [key, table] of Object.entries(tables)) {
    const rows = await pool.query(`SELECT * FROM ${table} ORDER BY 1, 2`);
    counts[key] = rows.rowCount;
    identities[key] = rows.rows;
  }
  return { counts, identities };
}
