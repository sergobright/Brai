#!/usr/bin/env node
import process from 'node:process';
import { BraiStore } from '../../services/brai_api/src/store.js';
import { canonicalReleaseRepository, explicitWorkFromPull, snapshotPull } from './accepted-preview-branches.mjs';

const payload = JSON.parse(process.env.BRAI_PR_JSON || '{}');
const pull = payload.pull_request ?? payload;
const suppliedRepository = payload.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? 'sergobright/Brai';
const explicitWork = explicitWorkFromPull(pull);
const repository = explicitWork ? canonicalReleaseRepository(suppliedRepository) : suppliedRepository;
if (!Number.isInteger(Number(pull.number))) throw new Error('GitHub pull request payload is required');

const store = new BraiStore(process.env.BRAI_DATABASE_URL || '');
try {
  const existing = store.db.prepare(`
    SELECT pulls.work_role, works.work_key
    FROM github_pull_requests AS pulls
    JOIN release_works AS works ON works.id = pulls.release_works_id
    WHERE pulls.repository = ? AND pulls.pull_number = ?
  `).get(repository, Number(pull.number));
  const work = existing ? { key: existing.work_key, role: existing.work_role } : explicitWork;
  if (!work) {
    console.log(`PR ${repository}#${pull.number} has no brai-work-v1 marker; skipped`);
    process.exitCode = 0;
  } else {
    const snapshot = snapshotPull(pull, repository, work);
    store.upsertGithubPullRequest({
      workKey: work.key,
      workRole: work.role,
      ...snapshot,
      updatedAtUtc: new Date().toISOString(),
    });
    console.log(`Recorded PR ${repository}#${pull.number} for ${work.key}/${work.role}`);
  }
} finally {
  store.close();
}
