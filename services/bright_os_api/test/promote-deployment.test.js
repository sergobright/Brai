import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrightOsStore } from '../src/store.js';

test('accepted preview promotion records the next dev build version once', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-ledger-'));
  const targetDb = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(targetDb);

  try {
    const accepted = {
      sourceBranch: 'codex/example',
      sourceCommit: 'abc123',
      sourceShortChanges: 'Fix version ledger descriptions.',
      sourceDetails: 'Accepted build rows now store human-readable release notes.',
      targetBranch: 'dev',
      targetCommit: 'def456',
      deployedAtUtc: '2026-06-24T22:00:00.000Z'
    };
    store.recordAcceptedBuildVersion({ ...accepted, releasedAtUtc: '2026-06-24T22:10:00.000Z' });
    store.recordAcceptedBuildVersion({ ...accepted, releasedAtUtc: '2026-06-24T22:10:00.000Z' });

    const version = store.db
      .prepare("SELECT * FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.12.1'")
      .get();
    assert.ok(version);
    assert.equal(version.build_version, 12);
    assert.equal(version.short_changes, 'Fix version ledger descriptions.');
    assert.equal(version.detailed_changes, 'Accepted build rows now store human-readable release notes.');
    assert.equal(version.reason, 'Needed because accepted build rows now store human-readable release notes.');
    assert.equal(version.released_at_utc, '2026-06-24T22:10:00.000Z');
    const ref = store.db
      .prepare("SELECT source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version = '0.0.12.1'")
      .get();
    assert.deepEqual(ref, {
      source_branch: 'codex/example',
      source_commit: 'abc123',
      target_branch: 'dev',
      target_commit: 'def456'
    });
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id = 'build'").get().count,
      12
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('production promotion copies accepted dev build ledger', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-prod-ledger-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const source = new BrightOsStore(sourceDb);
  const target = new BrightOsStore(targetDb);

  try {
    source.recordAcceptedBuildVersion({
      sourceBranch: 'codex/example-12',
      sourceCommit: 'abc12',
      sourceShortChanges: 'Fix example 12.',
      sourceDetails: 'Accepted dev build 12.',
      targetBranch: 'dev',
      targetCommit: 'def12',
      releasedAtUtc: '2026-06-25T12:00:00.000Z'
    });
    source.recordAcceptedBuildVersion({
      sourceBranch: 'codex/example-13',
      sourceCommit: 'abc13',
      sourceShortChanges: 'Fix example 13.',
      sourceDetails: 'Accepted dev build 13.',
      targetBranch: 'dev',
      targetCommit: 'def13',
      releasedAtUtc: '2026-06-25T13:00:00.000Z'
    });
    source.recordDeployment({
      environment: 'dev',
      branch: 'dev',
      commit: 'devsha',
      domain: 'dev.brightos.world',
      webOtaVersion: '0.0.13.1.20260625130000',
      shortChanges: 'Dev accepted changes.',
      detailedChanges: 'Latest accepted dev deployment.',
      reason: 'Automated dev deployment',
      deployedAtUtc: '2026-06-25T13:01:00.000Z'
    });
  } finally {
    source.close();
    target.close();
  }

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'dev',
    '--target-environment',
    'prod',
    '--target-branch',
    'main',
    '--target-commit',
    'mainsha',
    '--target-domain',
    'app.brightos.world',
    '--ledger-only',
    'true',
    '--reason',
    'Promote dev to production'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const latest = promoted.db
      .prepare("SELECT release_version, build_version, version, detailed_changes FROM build_versions WHERE version_type_id = 'build' ORDER BY release_version DESC, build_version DESC LIMIT 1")
      .get();
    assert.equal(latest.release_version, 1);
    assert.equal(latest.build_version, 13);
    assert.equal(latest.version, '0.1.13.1');
    assert.match(latest.detailed_changes, /0\.0\.12\.1/);
    assert.match(latest.detailed_changes, /0\.0\.13\.1/);

    const prodRecord = promoted.db
      .prepare("SELECT environment, branch, web_ota_version FROM deployment_records WHERE environment = 'prod' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(prodRecord, undefined);
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('production promotion can record accepted preview directly from preview metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-direct-prod-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const source = new BrightOsStore(sourceDb);
  const target = new BrightOsStore(targetDb);

  try {
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/direct-prod',
      commit: 'source-direct',
      domain: 'a.preview.brightos.world',
      webOtaVersion: '0.0.11.1.20260627000000',
      shortChanges: 'Ship direct production acceptance.',
      detailedChanges: 'Accepted preview metadata is promoted straight into production ledger.',
      reason: 'Prototype delivery skips dev.',
      deployedAtUtc: '2026-06-27T00:00:00.000Z'
    });
  } finally {
    source.close();
    target.close();
  }

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'codex/direct-prod',
    '--target-environment',
    'prod',
    '--target-branch',
    'main',
    '--target-commit',
    'mainsha-direct',
    '--target-domain',
    'app.brightos.world',
    '--ledger-only',
    'true',
    '--reason',
    'Promote accepted preview directly to production'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const accepted = promoted.db
      .prepare("SELECT version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND release_version = 0 ORDER BY build_version DESC LIMIT 1")
      .get();
    assert.deepEqual(accepted, {
      version: '0.0.12.1',
      short_changes: 'Ship direct production acceptance.',
      detailed_changes: 'Accepted preview metadata is promoted straight into production ledger.',
      reason: 'Prototype delivery skips dev.'
    });

    const release = promoted.db
      .prepare("SELECT release_version, build_version, version, detailed_changes FROM build_versions WHERE version_type_id = 'build' AND release_version > 0 ORDER BY release_version DESC LIMIT 1")
      .get();
    assert.equal(release.release_version, 1);
    assert.equal(release.build_version, 12);
    assert.equal(release.version, '0.1.12.1');
    assert.match(release.detailed_changes, /0\.0\.12\.1/);

    const refs = promoted.db
      .prepare("SELECT version, source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version IN ('0.0.12.1', '0.1.12.1') ORDER BY version")
      .all();
    assert.deepEqual(refs, [
      {
        version: '0.0.12.1',
        source_branch: 'codex/direct-prod',
        source_commit: 'source-direct',
        target_branch: 'codex/direct-prod',
        target_commit: 'source-direct'
      },
      {
        version: '0.1.12.1',
        source_branch: 'codex/direct-prod',
        source_commit: 'source-direct',
        target_branch: 'main',
        target_commit: 'mainsha-direct'
      }
    ]);

    const prodRecord = promoted.db
      .prepare("SELECT environment FROM deployment_records WHERE environment = 'prod' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(prodRecord, undefined);
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion falls back to branch commit metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-fallback-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const source = new BrightOsStore(sourceDb);
  const target = new BrightOsStore(targetDb);
  source.close();
  target.close();

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'codex/no-preview-metadata',
    '--source-commit',
    'abc-fallback',
    '--source-short-changes',
    'Fix fallback metadata.',
    '--source-details',
    'Acceptance uses commit summaries when preview metadata is missing.',
    '--target-environment',
    'dev',
    '--target-branch',
    'dev',
    '--target-commit',
    'merge-fallback',
    '--target-domain',
    'dev.brightos.world',
    '--reason',
    'Promote preview without deployment metadata'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const version = promoted.db
      .prepare("SELECT build_version, version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' ORDER BY build_version DESC LIMIT 1")
      .get();
    assert.equal(version.build_version, 12);
    assert.equal(version.version, '0.0.12.1');
    assert.equal(version.short_changes, 'Fix fallback metadata.');
    assert.equal(version.detailed_changes, 'Acceptance uses commit summaries when preview metadata is missing.');
    assert.equal(version.reason, 'Needed because acceptance uses commit summaries when preview metadata is missing.');
    assert.doesNotMatch(version.reason, /codex\/no-preview-metadata|abc-fallback/);
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion falls back when source database cannot be opened', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-unreadable-source-'));
  const sourceDb = path.join(tmp, 'missing', 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const target = new BrightOsStore(targetDb);
  target.close();

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'codex/unreadable-preview-db',
    '--source-commit',
    'abc-unreadable',
    '--source-short-changes',
    'Recover unreadable preview metadata.',
    '--source-details',
    'Recover unreadable preview metadata from commit fallback.',
    '--target-environment',
    'dev',
    '--target-branch',
    'dev',
    '--target-commit',
    'merge-unreadable',
    '--target-domain',
    'dev.brightos.world',
    '--reason',
    'Promote preview with unreadable source database'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const version = promoted.db
      .prepare("SELECT build_version, version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' ORDER BY build_version DESC LIMIT 1")
      .get();
    assert.equal(version.build_version, 12);
    assert.equal(version.version, '0.0.12.1');
    assert.equal(version.short_changes, 'Recover unreadable preview metadata.');
    assert.equal(version.detailed_changes, 'Recover unreadable preview metadata from commit fallback.');
    assert.equal(version.reason, 'Needed because recover unreadable preview metadata from commit fallback.');
    assert.doesNotMatch(version.reason, /codex\/unreadable-preview-db|abc-unreadable/);
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion ignores branch deployment metadata when commit fallback is useful', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-branch-deployment-source-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const source = new BrightOsStore(sourceDb);
  const target = new BrightOsStore(targetDb);

  try {
    source.recordDeployment({
      environment: 'preview-b',
      slot: 'B',
      branch: 'codex/branch-deployment-source',
      commit: 'source-branch-deployment',
      domain: 'b.test.brightos.world',
      shortChanges: 'Branch deployment',
      detailedChanges: 'Branch deployment',
      reason: 'Automated branch delivery',
      deployedAtUtc: '2026-06-26T15:00:00.000Z'
    });
  } finally {
    source.close();
    target.close();
  }

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'codex/branch-deployment-source',
    '--source-commit',
    'source-branch-deployment',
    '--source-short-changes',
    'Repair accepted build descriptions.',
    '--source-details',
    'Accepted build descriptions now use release notes instead of deployment metadata.',
    '--target-environment',
    'dev',
    '--target-branch',
    'dev',
    '--target-commit',
    'merge-branch-deployment',
    '--target-domain',
    'dev.brightos.world',
    '--reason',
    'Promote preview with technical source metadata'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const version = promoted.db
      .prepare("SELECT version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' ORDER BY build_version DESC LIMIT 1")
      .get();
    assert.equal(version.version, '0.0.12.1');
    assert.equal(version.short_changes, 'Repair accepted build descriptions.');
    assert.equal(version.detailed_changes, 'Accepted build descriptions now use release notes instead of deployment metadata.');
    assert.equal(version.reason, 'Needed because accepted build descriptions now use release notes instead of deployment metadata.');
    assert.doesNotMatch(version.reason, /codex\/branch-deployment-source|source-branch-deployment/);
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion ignores generic source metadata when commit fallback is useful', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-generic-source-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const source = new BrightOsStore(sourceDb);
  const target = new BrightOsStore(targetDb);

  try {
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/generic-source',
      commit: 'source-generic',
      domain: 'a.test.brightos.world',
      shortChanges: 'Accepted preview changes without authored release notes.',
      detailedChanges: 'No authored preview release notes were available; audit metadata is stored separately.',
      reason: 'Automated branch delivery',
      deployedAtUtc: '2026-06-26T15:45:00.000Z'
    });
  } finally {
    source.close();
    target.close();
  }

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'codex/generic-source',
    '--source-commit',
    'source-generic',
    '--source-short-changes',
    'Read accepted notes from git history.',
    '--source-details',
    'Accepted preview promotion now reads commit summaries when preview deployment metadata is generic.',
    '--target-environment',
    'dev',
    '--target-branch',
    'dev',
    '--target-commit',
    'merge-generic-source',
    '--target-domain',
    'dev.brightos.world',
    '--reason',
    'Promote preview with generic source metadata'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const version = promoted.db
      .prepare("SELECT version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' ORDER BY build_version DESC LIMIT 1")
      .get();
    assert.equal(version.version, '0.0.12.1');
    assert.equal(version.short_changes, 'Read accepted notes from git history.');
    assert.equal(version.detailed_changes, 'Accepted preview promotion now reads commit summaries when preview deployment metadata is generic.');
    assert.equal(version.reason, 'Needed because accepted preview promotion now reads commit summaries when preview deployment metadata is generic.');
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion does not write branch names when all source notes are technical', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-technical-only-source-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');
  const source = new BrightOsStore(sourceDb);
  const target = new BrightOsStore(targetDb);

  try {
    source.recordDeployment({
      environment: 'preview-c',
      slot: 'C',
      branch: 'codex/technical-only-source',
      commit: 'source-technical-only',
      domain: 'c.test.brightos.world',
      shortChanges: 'Accepted codex/technical-only-source.',
      detailedChanges: 'Accepted preview branch codex/technical-only-source@source-technical-only.',
      reason: 'Automated branch delivery',
      deployedAtUtc: '2026-06-26T15:30:00.000Z'
    });
  } finally {
    source.close();
    target.close();
  }

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
    '--source-db',
    sourceDb,
    '--target-db',
    targetDb,
    '--source-branch',
    'codex/technical-only-source',
    '--source-commit',
    'source-technical-only',
    '--source-short-changes',
    'Accepted codex/technical-only-source.',
    '--source-details',
    'Accepted preview branch codex/technical-only-source@source-technical-only.',
    '--target-environment',
    'dev',
    '--target-branch',
    'dev',
    '--target-commit',
    'merge-technical-only',
    '--target-domain',
    'dev.brightos.world',
    '--reason',
    'Promote preview with technical-only metadata'
  ], { cwd: repoRoot });

  const promoted = new BrightOsStore(targetDb);
  try {
    const version = promoted.db
      .prepare("SELECT version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' ORDER BY build_version DESC LIMIT 1")
      .get();
    assert.equal(version.version, '0.0.12.1');
    assert.equal(version.short_changes, 'Accepted preview changes without authored release notes.');
    assert.equal(version.detailed_changes, 'No authored preview release notes were available; audit metadata is stored separately.');
    assert.equal(version.reason, 'Needed because no authored preview release notes were available; audit metadata is stored separately.');
    assert.doesNotMatch(
      `${version.short_changes} ${version.detailed_changes} ${version.reason}`,
      /codex\/technical-only-source|source-technical-only|Accepted codex/
    );
  } finally {
    promoted.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('technical build version descriptions are repaired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-ledger-repair-'));
  const db = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(db);

  try {
    const expectedShortChanges = new Map([
      ['0.0.8.1', 'Aligned dev build ledger sequence.'],
      ['0.0.9.1', 'Added mobile edge menu swipe.'],
      ['0.0.10.1', 'Fixed preview slot release and queueing.'],
      ['0.0.11.1', 'Recorded accepted build ledger idempotently.'],
      ['0.0.12.1', 'Renamed Bright OS API infrastructure.'],
      ['0.0.13.1', 'Backfilled accepted build 0.0.11.1.'],
      ['0.0.14.1', 'Promoted dev build ledger to production.'],
      ['0.0.15.1', 'Fixed version ledger semantics.'],
      ['0.0.16.1', 'Required preview slot release after dev deploy.'],
      ['0.0.17.1', 'Fixed preview promotion metadata fallback.'],
      ['0.0.18.1', 'Connected Temporal CI/CD delivery gates.'],
      ['0.0.19.1', 'Document table_descriptions schema metadata rule.'],
      ['0.0.20.1', 'Optimize activity projection sync.'],
      ['0.0.21.1', 'Implemented focus session versioning.'],
      ['0.0.22.1', 'Enforced branch preview guard rails.'],
    ]);

    const updateExisting = store.db.prepare(`
      UPDATE build_versions
      SET short_changes = ?, detailed_changes = ?, reason = ?
      WHERE version_type_id = 'build' AND version = ?
    `);
    for (const version of ['0.0.8.1', '0.0.9.1', '0.0.10.1', '0.0.11.1']) {
      updateExisting.run(
        `Accepted PR #${version.split('.')[2]} into dev.`,
        `Recorded accepted PR #${version.split('.')[2]}: dev@old promoted to dev@old. Automated dev deployment from accepted PR #${version.split('.')[2]}.`,
        `Accepted PR #${version.split('.')[2]} into dev.`,
        version
      );
    }

    const insertBroken = store.db.prepare(`
      INSERT INTO build_versions (
        version_type_id,
        major_version,
        release_version,
        build_version,
        apk_version,
        version,
        short_changes,
        detailed_changes,
        reason,
        released_at_utc,
        created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const version of Array.from(expectedShortChanges.keys()).slice(4)) {
      const buildVersion = Number(version.split('.')[2]);
      insertBroken.run(
        'build',
        0,
        0,
        buildVersion,
        1,
        version,
        `Accepted dev build ${version}.`,
        `Accepted dev build ${version}: source codex/example@source-${buildVersion}; target dev@target-${buildVersion}. Automated deployment from codex/example@source-${buildVersion} to a.test.brightos.world.`,
        `Accepted dev build ${version}.`,
        '2026-06-25T19:00:00.000Z',
        '2026-06-25T19:00:00.000Z'
      );
    }

    store.repairTechnicalBuildVersionDescriptions();
    store.repairBuildVersionReasonText();

    const repaired = store.db
      .prepare("SELECT version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND build_version BETWEEN 8 AND 22 ORDER BY build_version")
      .all();
    assert.equal(repaired.length, expectedShortChanges.size);
    for (const row of repaired) {
      assert.equal(row.short_changes, expectedShortChanges.get(row.version));
      assert.doesNotMatch(row.detailed_changes, /Automated deployment|Automated dev deployment|source codex\/example|target dev@target-/);
      assert.doesNotMatch(row.reason, /Accepted dev build|Accepted PR|codex\/|@[0-9a-f]|->/);
    }
    assert.match(repaired.find((row) => row.version === '0.0.17.1').detailed_changes, /falls back to branch and commit metadata/);
    assert.match(repaired.find((row) => row.version === '0.0.18.1').detailed_changes, /Temporal/);
    assert.match(repaired.find((row) => row.version === '0.0.22.1').reason, /unsafe branches/);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('late technical build version descriptions are repaired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-late-ledger-repair-'));
  const db = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(db);

  try {
    const insertBroken = store.db.prepare(`
      INSERT INTO build_versions (
        version_type_id,
        major_version,
        release_version,
        build_version,
        apk_version,
        version,
        short_changes,
        detailed_changes,
        reason,
        released_at_utc,
        created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertBroken.run(
      'build',
      0,
      0,
      23,
      1,
      '0.0.23.1',
      'Accepted dev build 0.0.23.1.',
      'Accepted dev build 0.0.23.1: source codex/require-runtime-db-verification@source; target dev@target. Automated deployment from codex/require-runtime-db-verification@source to a.test.brightos.world.',
      'Accepted dev build 0.0.23.1.',
      '2026-06-26T14:48:00.000Z',
      '2026-06-26T14:48:00.000Z'
    );
    insertBroken.run(
      'build',
      0,
      0,
      24,
      1,
      '0.0.24.1',
      'Accepted codex/fix-build-version-descriptions.',
      'Accepted codex/fix-build-version-descriptions.',
      'Accepted dev build 0.0.24.1: codex/fix-build-version-descriptions@5c16c8450e77273d95d327f4792f502b0dfceee8 -> dev@d778efdcadfa06af938c91fe1247ab1309ebebf8.',
      '2026-06-26T15:18:00.000Z',
      '2026-06-26T15:18:00.000Z'
    );
    insertBroken.run(
      'build',
      0,
      0,
      25,
      1,
      '0.0.25.1',
      'Accepted codex/repair-late-build-version-descriptions.',
      'Accepted codex/repair-late-build-version-descriptions.',
      'Accepted dev build 0.0.25.1: codex/repair-late-build-version-descriptions@50caeb4c844d0487d04a28de64ced4161c1eaa00 -> dev@a1887a755689967b2a892ebc6a8b50ca31072958.',
      '2026-06-26T15:36:00.000Z',
      '2026-06-26T15:36:00.000Z'
    );

    store.repairLateTechnicalBuildVersionDescriptions();
    store.repairBuildVersionReasonText();

    const repaired = store.db
      .prepare("SELECT version, short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND build_version BETWEEN 23 AND 25 ORDER BY build_version")
      .all();
    assert.deepEqual(repaired.map((row) => row.short_changes), [
      'Required runtime DB fact verification.',
      'Fixed build version release notes.',
      'Repaired late build version descriptions.',
    ]);
    for (const row of repaired) {
      assert.doesNotMatch(row.detailed_changes, /Accepted codex\/|Automated deployment|source codex\//);
      assert.doesNotMatch(row.reason, /Accepted dev build|codex\/|@[0-9a-f]|->/);
    }
    assert.match(repaired.find((row) => row.version === '0.0.23.1').reason, /checking the real runtime target/);
    assert.match(repaired.find((row) => row.version === '0.0.24.1').reason, /readable release notes/);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted audit metadata fallback build description is repaired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-audit-metadata-ledger-repair-'));
  const db = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(db);

  try {
    store.db.prepare(`
      INSERT INTO build_versions (
        version_type_id,
        major_version,
        release_version,
        build_version,
        apk_version,
        version,
        short_changes,
        detailed_changes,
        reason,
        released_at_utc,
        created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'build',
      0,
      0,
      26,
      1,
      '0.0.26.1',
      'Accepted preview changes without authored release notes.',
      'No authored preview release notes were available; audit metadata is stored separately.',
      'Needed because no authored preview release notes were available; audit metadata is stored separately.',
      '2026-06-26T15:49:00.000Z',
      '2026-06-26T15:49:00.000Z'
    );

    store.repairAcceptedAuditMetadataBuildVersionDescription();

    const repaired = store.db
      .prepare("SELECT short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.26.1'")
      .get();
    assert.equal(repaired.short_changes, 'Separated build ledger audit metadata.');
    assert.match(repaired.detailed_changes, /store branch and commit audit references/);
    assert.match(repaired.reason, /preview source commit/);
    assert.doesNotMatch(
      `${repaired.short_changes} ${repaired.detailed_changes} ${repaired.reason}`,
      /Accepted preview changes without authored release notes|codex\/|@[0-9a-f]|->/
    );

    const ref = store.db
      .prepare("SELECT source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version = '0.0.26.1'")
      .get();
    assert.deepEqual(ref, {
      source_branch: 'codex/repair-late-build-version-descriptions',
      source_commit: 'ca6b2e282d6bbc5f8fd2b2f11817e89c6791fac1',
      target_branch: 'dev',
      target_commit: 'f3592f7c9adfc492e5920623aefda087532d6015'
    });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('generic accepted build notes description is repaired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-generic-notes-ledger-repair-'));
  const db = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(db);

  try {
    store.db.prepare(`
      INSERT INTO build_versions (
        version_type_id,
        major_version,
        release_version,
        build_version,
        apk_version,
        version,
        short_changes,
        detailed_changes,
        reason,
        released_at_utc,
        created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'build',
      0,
      0,
      27,
      1,
      '0.0.27.1',
      'Accepted preview changes without authored release notes.',
      'No authored preview release notes were available; audit metadata is stored separately.',
      'Needed because no authored preview release notes were available; audit metadata is stored separately.',
      '2026-06-26T16:02:00.000Z',
      '2026-06-26T16:02:00.000Z'
    );

    store.repairGenericAcceptedBuildNotesDescription();

    const repaired = store.db
      .prepare("SELECT short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.27.1'")
      .get();
    assert.equal(repaired.short_changes, 'Used preview source for accepted build notes.');
    assert.match(repaired.detailed_changes, /preview checkout/);
    assert.match(repaired.reason, /generic no-release-notes text/);
    assert.doesNotMatch(
      `${repaired.short_changes} ${repaired.detailed_changes} ${repaired.reason}`,
      /Accepted preview changes without authored release notes|codex\/|@[0-9a-f]|->/
    );

    const ref = store.db
      .prepare("SELECT source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version = '0.0.27.1'")
      .get();
    assert.deepEqual(ref, {
      source_branch: 'codex/repair-late-build-version-descriptions',
      source_commit: '2804346377fbb3f2cb81ff703d79ae20cd0ef735',
      target_branch: 'dev',
      target_commit: '449bb5a9a908243dd0a2685b2e56519b86a92393'
    });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted git notes build description is repaired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-git-notes-ledger-repair-'));
  const db = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(db);

  try {
    store.db.prepare(`
      INSERT INTO build_versions (
        version_type_id,
        major_version,
        release_version,
        build_version,
        apk_version,
        version,
        short_changes,
        detailed_changes,
        reason,
        released_at_utc,
        created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'build',
      0,
      0,
      28,
      1,
      '0.0.28.1',
      'Accepted preview changes without authored release notes.',
      'No authored preview release notes were available; audit metadata is stored separately.',
      'Needed because no authored preview release notes were available; audit metadata is stored separately.',
      '2026-06-26T16:21:00.000Z',
      '2026-06-26T16:21:00.000Z'
    );

    store.repairAcceptedGitNotesBuildVersionDescription();

    const repaired = store.db
      .prepare("SELECT short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.28.1'")
      .get();
    assert.equal(repaired.short_changes, 'Read accepted build notes from git history.');
    assert.match(repaired.detailed_changes, /tar-copied preview\/dev sources/);
    assert.match(repaired.reason, /authored source commit notes/);
    assert.doesNotMatch(
      `${repaired.short_changes} ${repaired.detailed_changes} ${repaired.reason}`,
      /Accepted preview changes without authored release notes|codex\/|@[0-9a-f]|->/
    );

    const ref = store.db
      .prepare("SELECT source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version = '0.0.28.1'")
      .get();
    assert.deepEqual(ref, {
      source_branch: 'codex/repair-late-build-version-descriptions',
      source_commit: '53866e6800be4c5789a60ef049911d26a5693b0a',
      target_branch: 'dev',
      target_commit: '1dc4f8af7eb719aa8632b40a3f8b569f2a47884d'
    });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted ssh notes build description is repaired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-ssh-notes-ledger-repair-'));
  const db = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(db);

  try {
    store.db.prepare(`
      INSERT INTO build_versions (
        version_type_id,
        major_version,
        release_version,
        build_version,
        apk_version,
        version,
        short_changes,
        detailed_changes,
        reason,
        released_at_utc,
        created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'build',
      0,
      0,
      29,
      1,
      '0.0.29.1',
      'Pass',
      'accepted',
      'Needed because accepted.',
      '2026-06-26T16:35:00.000Z',
      '2026-06-26T16:35:00.000Z'
    );

    store.repairAcceptedSshNotesBuildVersionDescription();

    const repaired = store.db
      .prepare("SELECT short_changes, detailed_changes, reason FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.29.1'")
      .get();
    assert.equal(repaired.short_changes, 'Passed accepted build notes before SSH.');
    assert.match(repaired.detailed_changes, /GitHub runner/);
    assert.match(repaired.reason, /server during preview promotion/);
    assert.doesNotMatch(
      `${repaired.short_changes} ${repaired.detailed_changes} ${repaired.reason}`,
      /^Pass accepted Needed because accepted\.$/
    );

    const ref = store.db
      .prepare("SELECT source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version = '0.0.29.1'")
      .get();
    assert.deepEqual(ref, {
      source_branch: 'codex/repair-late-build-version-descriptions',
      source_commit: 'bdb660b18b0e20363967c15a8018548be32550df',
      target_branch: 'dev',
      target_commit: 'e68cf2685dfce4903f7d28dc8e38ef7c7ab25d8f'
    });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
