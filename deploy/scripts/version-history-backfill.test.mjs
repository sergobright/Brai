import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createTestDatabase } from "../../services/brai_api/test-support/api.js";
import {
  applyVersionHistoryBackfill,
  buildReport,
  retitleHistoricalManifest,
  validateManifest
} from "./version-history-backfill.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");
const manifestPath = path.join(root, "supabase/backfills/version-history-20260714.json");
const reportPath = path.join(root, "supabase/backfills/version-history-20260714-report.json");
const genericTitles = new Set(["production", "environment flavors", "configstore", "securestringstore", "durablequeue", "task-start", "android package", "timer", "manifest"]);
const contentWords = (value) => String(value ?? "").match(/[\p{L}\p{N}_]+(?:[-./][\p{L}\p{N}_]+)*/gu) || [];
const contextDependentDetail = /^(?:это|эта|этот|эти|они|их|остальные|не весь|переключение обратно)(?:\s|$)/iu;
const genericActionTitle = /^(?:действия|изменения|исправления|улучшения|обновления|разное|прочее|добавлен[аоы]? (?:проверка|тесты?|поддержка)|исправлены guard sync|добавлены reliability)(?:[.!…]|$)/iu;
const nonChangeDetail = /(?:не (?:менял(?:ась|ось|ись)?|изменял(?:ась|ось|ись)?)|остаются доступными)(?:[.!…]|$)/iu;

test("checked-in cutoff manifest and report are deterministic and complete", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  assert.doesNotThrow(() => validateManifest(manifest));
  assert.deepEqual(retitleHistoricalManifest(manifest), manifest);
  assert.deepEqual(buildReport(manifest), report);
  assert.deepEqual(report.counts.versions_by_type, { apk: 11, build: 148 });
  assert.equal(report.counts.versions, 159);
  assert.equal(report.counts.merged_pull_requests_imported, 288);
  assert.equal(report.counts.details, 348);
  assert.equal(report.counts.imported_but_unlinked_pull_requests, 163);
  assert.equal(report.counts.versions_without_pull_requests, 24);
  for (const version of manifest.versions) {
    assert.doesNotMatch(version.details.map((detail) => detail.title).join("\n"), /\s(?:—|-)\s*\d+$/mu);
    assert.doesNotMatch(version.details.map((detail) => detail.title).join("\n"), /…|\.\.\./u);
    assert.equal(version.details.some((detail) => genericTitles.has(comparable(detail.title))), false);
    assert.equal(version.details.some((detail) => {
      const titleWords = contentWords(detail.title);
      return titleWords.length <= 2 && /[A-Za-z]/u.test(detail.title) && !/[А-Яа-яЁё]/u.test(detail.title);
    }), false);
    assert.equal(version.details.some((detail) => contentWords(detail.description).length <= 5), false);
    assert.equal(version.details.some((detail) => contextDependentDetail.test(detail.title) || contextDependentDetail.test(detail.description)), false);
    assert.equal(version.details.some((detail) => genericActionTitle.test(detail.title)), false);
    assert.equal(version.details.some((detail) => nonChangeDetail.test(`${detail.title}\n${detail.description}`)), false);
    assert.equal(version.details.some((detail) => comparable(detail.title) === comparable(version.parent.short_changes)), false);
    assert.equal(version.details.some((detail) => comparable(detail.title) === comparable(version.parent.detailed_changes)), false);
    assert.equal(version.details.some((detail) => comparable(detail.title) === comparable(version.parent.reason)), false);
    assert.equal(version.details.some((detail) => comparable(detail.description) === comparable(version.parent.short_changes)), false);
    assert.equal(version.details.some((detail) => comparable(detail.description) === comparable(version.parent.detailed_changes)), false);
    assert.equal(version.details.some((detail) => comparable(detail.description) === comparable(version.parent.reason)), false);
    assert.equal(version.details.some((detail) => comparable(detail.title) === comparable(detail.description)), false);
    assert.equal(version.details.some((detail) => {
      const firstFragment = comparable(detail.description.split(/[,;:]\s+|\s+[—–]\s+/u)[0]);
      return comparable(detail.title).split(/\s+/u).length < 3 && comparable(detail.title) === firstFragment;
    }), false);
    assert.equal(new Set(version.details.map((detail) => `${comparable(detail.title)}\n${comparable(detail.description)}`)).size, version.details.length);
    assert.equal(new Set(version.details.map((detail) => comparable(detail.title))).size, version.details.length);
    assert.equal(new Set(version.details.map((detail) => comparable(detail.description))).size, version.details.length);
  }
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

  const truncated = structuredClone(manifest);
  truncated.versions[0].details[0].title = "Автоматически обрезанный заголовок…";
  assert.throws(() => validateManifest(truncated), /truncated detail title/);

  const genericFragment = structuredClone(manifest);
  genericFragment.versions[0].details[0].title = "Production";
  genericFragment.versions[0].details[0].description = "Production, Dev и Preview используют общий endpoint.";
  assert.throws(() => validateManifest(genericFragment), /generic detail title/);

  const shortLatin = structuredClone(manifest);
  shortLatin.versions[0].details[0].title = "Guard sync";
  assert.throws(() => validateManifest(shortLatin), /short Latin-only detail title/);

  const shortDescription = structuredClone(manifest);
  shortDescription.versions[0].details[0].description = "Добавлен ai_logs.";
  assert.throws(() => validateManifest(shortDescription), /short detail description/);

  const contextDependent = structuredClone(manifest);
  contextDependent.versions[0].details[0].title = "Это устраняет падение image_describer";
  assert.throws(() => validateManifest(contextDependent), /context-dependent detail/);

  const genericAction = structuredClone(manifest);
  genericAction.versions[0].details[0].title = "Добавлена проверка";
  assert.throws(() => validateManifest(genericAction), /generic action detail title/);

  const nonChange = structuredClone(manifest);
  nonChange.versions[0].details[0].title = "Неизменная APK-линия";
  nonChange.versions[0].details[0].description = "Native APK-линия этого выпуска по-прежнему не менялась.";
  assert.throws(() => validateManifest(nonChange), /non-change detail wording/);

  for (const [detailField, parentField] of [
    ["title", "detailed_changes"],
    ["title", "reason"],
    ["description", "short_changes"],
    ["description", "reason"]
  ]) {
    const parentCopy = structuredClone(manifest);
    parentCopy.versions[0].details[0][detailField] = parentCopy.versions[0].parent[parentField];
    assert.throws(() => validateManifest(parentCopy), /duplicates the parent/);
  }
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

    const liveWork = await pool.query(`
      INSERT INTO release_works (work_key, status, created_at_utc, updated_at_utc, finalized_at_utc)
      VALUES ('live:work:503', 'finalized', '2026-07-15T09:00:00.000Z', '2026-07-15T10:00:00.000Z', '2026-07-15T10:00:00.000Z')
      RETURNING id
    `);
    await pool.query(`
      INSERT INTO github_pull_requests (
        release_works_id, work_role, repository, pull_number, url, title, body, author_login,
        state, is_draft, head_branch, base_branch, merge_commit_sha,
        github_created_at_utc, github_updated_at_utc, github_closed_at_utc, github_merged_at_utc,
        created_at_utc, updated_at_utc
      )
      SELECT $1, 'support', repository, 503, 'https://github.com/sergobright/Brai/pull/503',
        'Live support PR 503', body, author_login, state, is_draft, 'codex/live-support-503',
        base_branch, 'merge-live-503', github_created_at_utc, github_updated_at_utc,
        github_closed_at_utc, github_merged_at_utc, created_at_utc, updated_at_utc
      FROM github_pull_requests WHERE repository='sergobright/Brai' AND pull_number=501
    `, [liveWork.rows[0].id]);
    const manifestWithUnlinkedSnapshot = structuredClone(manifest);
    manifestWithUnlinkedSnapshot.release_works.push({
      ...structuredClone(manifest.release_works[0]),
      work_key: "legacy:pr:sergobright/Brai:503"
    });
    manifestWithUnlinkedSnapshot.pull_requests.push({
      ...structuredClone(manifest.pull_requests[0]),
      work_key: "legacy:pr:sergobright/Brai:503",
      pull_number: 503,
      url: "https://github.com/sergobright/Brai/pull/503",
      title: "Historical snapshot PR 503",
      head_branch: "codex/historical-503",
      merge_commit_sha: "merge-503"
    });
    await applyVersionHistoryBackfill(pool, manifestWithUnlinkedSnapshot);
    const preservedMembership = (await pool.query(`
      SELECT pulls.work_role, works.work_key, pulls.title
      FROM github_pull_requests AS pulls
      JOIN release_works AS works ON works.id=pulls.release_works_id
      WHERE pulls.repository='sergobright/Brai' AND pulls.pull_number=503
    `)).rows[0];
    assert.deepEqual(preservedMembership, {
      work_role: "support",
      work_key: "live:work:503",
      title: "Historical snapshot PR 503"
    });

    await pool.query(`
      UPDATE github_pull_requests
      SET release_works_id=$1, work_role='support'
      WHERE repository='sergobright/Brai' AND pull_number=501
    `, [liveWork.rows[0].id]);
    await assert.rejects(
      applyVersionHistoryBackfill(pool, manifest),
      /existing PR membership differs for sergobright\/Brai#501/
    );

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

    const duplicateParent = structuredClone(rollbackManifest);
    duplicateParent.versions[0].details[0].description = duplicateParent.versions[0].parent.detailed_changes;
    assert.throws(() => validateManifest(duplicateParent), /detail description duplicates the parent summary/);

    const duplicateDetail = structuredClone(rollbackManifest);
    duplicateDetail.versions[0].details.push(structuredClone(duplicateDetail.versions[0].details[0]));
    assert.throws(() => validateManifest(duplicateDetail), /duplicate detail/);

    const numbered = structuredClone(rollbackManifest);
    numbered.versions[0].details[0].title = "Изменение — 1";
    assert.throws(() => validateManifest(numbered), /automatic numeric detail title/);

    const repeatedDescription = structuredClone(rollbackManifest);
    repeatedDescription.versions[0].details[0].title = repeatedDescription.versions[0].details[0].description;
    assert.throws(() => validateManifest(repeatedDescription), /detail title repeats its description/);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test("full 159-version/288-PR cutoff backfill is identical on its second run", {
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
    await seedVersion(pool, 149, "2026-07-15T17:01:00.000Z");

    const firstReport = await applyVersionHistoryBackfill(pool, manifest);
    const firstIdentity = await identityDigest(pool);
    const secondReport = await applyVersionHistoryBackfill(pool, manifest);
    const secondIdentity = await identityDigest(pool);
    assert.deepEqual(secondReport, firstReport);
    assert.deepEqual(secondIdentity, firstIdentity);
    assert.deepEqual(firstIdentity.counts, {
      details: 349,
      links: 135,
      pulls: 288,
      refs: 136,
      versions: 160,
      works: 288
    });
    const postCutoff = await pool.query(`
      SELECT details.title, details.description, details.github_pull_requests_id
      FROM build_version_details AS details
      JOIN build_versions AS versions ON versions.id=details.build_versions_id
      WHERE versions.version_type_id='build' AND versions.version=149
    `);
    assert.deepEqual(postCutoff.rows, [{
      title: "Short 149",
      description: "Detailed 149",
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

function comparable(value) {
  return String(value).trim().replace(/\s+/g, " ").replace(/[.!?]+$/u, "").toLocaleLowerCase("ru-RU");
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
        short_changes: `Резюме выпуска ${version}.`,
        detailed_changes: `Релиз объединяет две независимые проверки истории ${version}.`,
        reason: `Нужно подтвердить повторяемость исторического backfill ${version}.`,
        released_at_utc: releasedAtUtc,
        created_at_utc: releasedAtUtc
      },
      details: [
        {
          title: "Первая атомарная запись",
          description: "Первая атомарная запись проверяет сохранение стабильных идентификаторов.",
          pull_number: pullNumber
        },
        {
          title: "Вторая атомарная запись",
          description: "Вторая атомарная запись проверяет повторное применение без дублей.",
          pull_number: pullNumber
        }
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
