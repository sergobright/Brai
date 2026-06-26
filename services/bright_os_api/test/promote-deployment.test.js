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
    assert.equal(version.reason, 'Accepted dev build 0.0.12.1: codex/example@abc123 -> dev@def456.');
    assert.equal(version.released_at_utc, '2026-06-24T22:10:00.000Z');
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
    assert.match(version.reason, /codex\/no-preview-metadata@abc-fallback/);
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
    '--source-details',
    'Accepted preview branch codex/unreadable-preview-db@abc-unreadable.',
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
    assert.equal(version.short_changes, 'Accepted codex/unreadable-preview-db.');
    assert.equal(version.detailed_changes, 'Accepted codex/unreadable-preview-db.');
    assert.match(version.reason, /codex\/unreadable-preview-db@abc-unreadable/);
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
      17,
      1,
      '0.0.17.1',
      'Accepted dev build 0.0.17.1.',
      'Accepted dev build 0.0.17.1: source codex/require-preview-slot-release@c811cf9c584fa06b58e416118957b68f2066f59b; target dev@6ae3a7b2c23c561194375d42b49bccdebb49ac77. Accepted preview branch codex/require-preview-slot-release@c811cf9c584fa06b58e416118957b68f2066f59b.',
      'Accepted dev build 0.0.17.1.',
      '2026-06-25T19:00:00.000Z',
      '2026-06-25T19:00:00.000Z'
    );

    store.repairTechnicalBuildVersionDescriptions();

    const repaired = store.db
      .prepare("SELECT short_changes, detailed_changes, reason FROM build_versions WHERE version = '0.0.17.1'")
      .get();
    assert.equal(repaired.short_changes, 'Require preview slot release after dev deploy.');
    assert.match(repaired.detailed_changes, /keeps the slot reserved/);
    assert.match(repaired.reason, /codex\/require-preview-slot-release@c811cf9/);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
