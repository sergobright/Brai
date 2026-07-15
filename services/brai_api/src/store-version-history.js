import { assertPublicHistorySafe, publicHistoryText } from './public-history-safety.js';

const TERMINAL_PULL_STATES = new Set(['CLOSED', 'MERGED']);

export const versionHistoryMethods = {
  upsertReleaseWork({ workKey, status = 'active', createdAtUtc = new Date().toISOString(), finalizedAtUtc = null }) {
    const key = requiredText(workKey, 'work_key');
    if (!['active', 'finalizing', 'finalized', 'cancelled'].includes(status)) throw new Error(`invalid work status: ${status}`);
    if ((status === 'finalized') !== Boolean(finalizedAtUtc)) throw new Error('finalized work status and finalized_at_utc must be set together');
    return this.db.prepare(`
      INSERT INTO release_works (work_key, status, created_at_utc, updated_at_utc, finalized_at_utc)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (work_key) DO UPDATE SET
        status = CASE WHEN release_works.status IN ('finalized', 'cancelled') THEN release_works.status ELSE excluded.status END,
        updated_at_utc = CASE WHEN release_works.status IN ('finalized', 'cancelled') THEN release_works.updated_at_utc ELSE excluded.updated_at_utc END,
        finalized_at_utc = COALESCE(release_works.finalized_at_utc, excluded.finalized_at_utc)
      RETURNING *
    `).get(key, status, createdAtUtc, createdAtUtc, finalizedAtUtc);
  },

  releaseWork(workKey) {
    return this.db.prepare('SELECT * FROM release_works WHERE work_key = ?').get(workKey);
  },

  upsertGithubPullRequest(input) {
    return inTransaction(this, () => {
      const now = input.updatedAtUtc ?? new Date().toISOString();
      const work = this.upsertReleaseWork({ workKey: input.workKey, createdAtUtc: now });
      if (work.status === 'cancelled') throw new Error(`release work is cancelled: ${input.workKey}`);
      const repository = requiredText(input.repository, 'repository');
      const pullNumber = positiveInteger(input.pullNumber, 'pull_number');
      const role = input.workRole;
      if (!['owner', 'support'].includes(role)) throw new Error(`invalid work role: ${role}`);
      const existing = this.db.prepare(`
        SELECT github_pull_requests.*, release_works.work_key
        FROM github_pull_requests
        JOIN release_works ON release_works.id = github_pull_requests.release_works_id
        WHERE repository = ? AND pull_number = ?
      `).get(repository, pullNumber);
      if (existing && (existing.work_key !== input.workKey || existing.work_role !== role)) {
        throw new Error(`PR ${repository}#${pullNumber} already belongs to ${existing.work_key} as ${existing.work_role}`);
      }
      if (work.status === 'finalized') {
        if (!existing) throw new Error(`cannot register a new PR in finalized work ${input.workKey}`);
        return existing;
      }
      const saved = this.db.prepare(`
        INSERT INTO github_pull_requests (
          release_works_id, work_role, repository, pull_number, url, title, body, author_login,
          state, is_draft, head_branch, base_branch, merge_commit_sha,
          github_created_at_utc, github_updated_at_utc, github_closed_at_utc, github_merged_at_utc,
          created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (repository, pull_number) DO UPDATE SET
          url = excluded.url,
          title = excluded.title,
          body = excluded.body,
          author_login = excluded.author_login,
          state = excluded.state,
          is_draft = excluded.is_draft,
          head_branch = excluded.head_branch,
          base_branch = excluded.base_branch,
          merge_commit_sha = excluded.merge_commit_sha,
          github_created_at_utc = excluded.github_created_at_utc,
          github_updated_at_utc = excluded.github_updated_at_utc,
          github_closed_at_utc = excluded.github_closed_at_utc,
          github_merged_at_utc = excluded.github_merged_at_utc,
          updated_at_utc = excluded.updated_at_utc
        WHERE github_pull_requests.release_works_id = excluded.release_works_id
          AND github_pull_requests.work_role = excluded.work_role
        RETURNING *
      `).get(
        work.id,
        role,
        repository,
        pullNumber,
        requiredText(input.url, 'url'),
        requiredText(input.title, 'title'),
        String(input.body ?? ''),
        requiredText(input.authorLogin, 'author_login'),
        requiredText(input.state, 'state').toUpperCase(),
        Boolean(input.isDraft),
        requiredText(input.headBranch, 'head_branch'),
        requiredText(input.baseBranch, 'base_branch'),
        nullableText(input.mergeCommitSha),
        requiredText(input.githubCreatedAtUtc, 'github_created_at_utc'),
        requiredText(input.githubUpdatedAtUtc, 'github_updated_at_utc'),
        nullableText(input.githubClosedAtUtc),
        nullableText(input.githubMergedAtUtc),
        existing?.created_at_utc ?? now,
        now,
      );
      if (!saved) throw new Error(`PR ${repository}#${pullNumber} was concurrently assigned to another work or role`);
      return saved;
    });
  },

  transferReleaseWorkOwnership({ workKey, repository, fromPullNumber, toPullNumber, updatedAtUtc = new Date().toISOString() }) {
    return inTransaction(this, () => {
      const work = requiredWork(this, workKey, { forUpdate: true });
      if (work.status !== 'active') throw new Error(`cannot transfer ownership for ${workKey} in ${work.status} state`);
      const from = requiredPull(this, work.id, repository, fromPullNumber);
      const to = requiredPull(this, work.id, repository, toPullNumber);
      if (from.work_role !== 'owner') throw new Error(`PR #${fromPullNumber} is not the work owner`);
      this.db.prepare('UPDATE github_pull_requests SET work_role = ?, updated_at_utc = ? WHERE id = ?').run('support', updatedAtUtc, from.id);
      this.db.prepare('UPDATE github_pull_requests SET work_role = ?, updated_at_utc = ? WHERE id = ?').run('owner', updatedAtUtc, to.id);
      return { workKey, ownerPullNumber: toPullNumber };
    });
  },

  cancelReleaseWork({ workKey, updatedAtUtc = new Date().toISOString() }) {
    return inTransaction(this, () => {
      const work = requiredWork(this, workKey, { forUpdate: true });
      if (work.status !== 'active') throw new Error(`cannot cancel ${workKey} in ${work.status} state`);
      const merged = this.db.prepare(`
        SELECT pull_number FROM github_pull_requests
        WHERE release_works_id = ? AND (state = 'MERGED' OR github_merged_at_utc IS NOT NULL)
        ORDER BY pull_number
      `).all(work.id);
      if (merged.length) throw new Error(`cannot cancel ${workKey}; merged PRs remain unversioned: ${merged.map((row) => `#${row.pull_number}`).join(', ')}`);
      this.db.prepare("UPDATE release_works SET status = 'cancelled', updated_at_utc = ? WHERE id = ?").run(updatedAtUtc, work.id);
    });
  },

  finalizeVersionWork(input) {
    const now = input.releasedAtUtc ?? new Date().toISOString();
    const versionTypeId = requiredText(input.versionTypeId ?? 'build', 'version_type_id');
    const details = normalizeDetails(input.details);
    return inTransaction(this, () => {
      const work = requiredWork(this, input.workKey, { forUpdate: true });
      const pulls = this.db.prepare(`
        SELECT * FROM github_pull_requests
        WHERE release_works_id = ?
        ORDER BY github_merged_at_utc NULLS LAST, pull_number
      `).all(work.id);
      const unresolved = pulls.filter((pull) => !TERMINAL_PULL_STATES.has(pull.state));
      if (versionTypeId === 'build' && unresolved.length) {
        throw new Error(`work ${input.workKey} has unresolved PRs: ${unresolved.map((pull) => `#${pull.pull_number} (${pull.state})`).join(', ')}`);
      }
      const owners = pulls.filter((pull) => pull.work_role === 'owner');
      const mergedOwners = owners.filter((pull) => pull.state === 'MERGED' || pull.github_merged_at_utc);
      if (versionTypeId === 'build' && !input.allowSupportOnly && (owners.length !== 1 || mergedOwners.length !== 1)) {
        throw new Error(`work ${input.workKey} requires exactly one merged owner PR`);
      }
      if (versionTypeId === 'build' && input.allowSupportOnly) {
        const mergedSupports = pulls.filter((pull) => pull.work_role === 'support' && (pull.state === 'MERGED' || pull.github_merged_at_utc));
        const liveOrMergedOwners = owners.filter((pull) => pull.state !== 'CLOSED' || pull.github_merged_at_utc);
        if (liveOrMergedOwners.length || !mergedSupports.length) {
          throw new Error(`support-only finalization for ${input.workKey} requires merged support PRs and no live or merged owner`);
        }
      }
      const pullsByNumber = new Map(pulls.map((pull) => [pull.pull_number, pull]));
      const mergedPullNumbers = pulls
        .filter((pull) => pull.state === 'MERGED' || pull.github_merged_at_utc)
        .map((pull) => pull.pull_number)
        .sort((left, right) => left - right);
      const requestedPulls = input.pullNumbers == null
        ? mergedPullNumbers
        : [...new Set(input.pullNumbers.map((value) => positiveInteger(value, 'pull_number')))];
      if (versionTypeId === 'build') {
        const requestedBuildPulls = [...requestedPulls].sort((left, right) => left - right);
        if (JSON.stringify(requestedBuildPulls) !== JSON.stringify(mergedPullNumbers)) {
          throw new Error(`build for ${input.workKey} must link every merged work PR`);
        }
      }
      const existing = this.db.prepare(`
        SELECT * FROM build_versions WHERE release_works_id = ? AND version_type_id = ?
      `).get(work.id, versionTypeId);
      if (existing) {
        assertExistingVersion(this, existing, work, input, details, requestedPulls);
        return { versionTypeId, version: existing.version, id: existing.id, created: false };
      }

      if (versionTypeId === 'build') {
        this.db.prepare("UPDATE release_works SET status = 'finalizing', updated_at_utc = ? WHERE id = ?").run(now, work.id);
      }
      const version = input.version == null ? this.nextVersion(versionTypeId) : positiveInteger(input.version, 'version');
      const conflictingVersion = this.db.prepare(`
        SELECT release_works_id FROM build_versions WHERE version_type_id = ? AND version = ?
      `).get(versionTypeId, version);
      if (conflictingVersion && conflictingVersion.release_works_id !== work.id) {
        throw new Error(`${versionTypeId} ${version} already belongs to another release work`);
      }
      this.upsertBuildVersion({
        versionTypeId,
        version,
        includedInVersionId: input.includedInVersionId ?? null,
        releaseWorkId: work.id,
        shortChanges: requiredText(input.shortChanges, 'short_changes'),
        detailedChanges: requiredText(input.detailedChanges, 'detailed_changes'),
        reason: requiredText(input.reason, 'reason'),
        releasedAtUtc: now,
        sourceBranch: input.sourceBranch ?? null,
        sourceCommit: input.sourceCommit ?? null,
        targetBranch: input.targetBranch ?? null,
        targetCommit: input.targetCommit ?? null,
      });
      const parent = this.db.prepare('SELECT * FROM build_versions WHERE version_type_id = ? AND version = ?').get(versionTypeId, version);
      details.forEach((detail, index) => {
        const sourcePull = detail.pullNumber == null ? null : pullsByNumber.get(detail.pullNumber);
        if (detail.pullNumber != null && !sourcePull) throw new Error(`detail references PR #${detail.pullNumber} outside work ${input.workKey}`);
        if (sourcePull && sourcePull.state !== 'MERGED' && !sourcePull.github_merged_at_utc) throw new Error(`detail references unmerged PR #${detail.pullNumber}`);
        if (sourcePull && !requestedPulls.includes(sourcePull.pull_number)) throw new Error(`detail references PR #${detail.pullNumber} that is not linked to this ${versionTypeId}`);
        this.db.prepare(`
          INSERT INTO build_version_details (
            build_versions_id, github_pull_requests_id, title, description, display_order, created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(parent.id, sourcePull?.id ?? null, detail.title, detail.description, index + 1, now, now);
      });

      for (const pullNumber of requestedPulls) {
        const pull = pullsByNumber.get(pullNumber);
        if (!pull || (pull.state !== 'MERGED' && !pull.github_merged_at_utc)) throw new Error(`PR #${pullNumber} is not a merged member of ${input.workKey}`);
        this.db.prepare(`
          INSERT INTO build_version_pull_requests (build_versions_id, version_type_id, github_pull_requests_id, created_at_utc)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (build_versions_id, github_pull_requests_id) DO NOTHING
        `).run(parent.id, versionTypeId, pull.id, now);
      }
      if (versionTypeId === 'build') {
        this.db.prepare("UPDATE release_works SET status = 'finalized', finalized_at_utc = ?, updated_at_utc = ? WHERE id = ?").run(now, now, work.id);
      } else {
        this.db.prepare('UPDATE release_works SET updated_at_utc = ? WHERE id = ?').run(now, work.id);
      }
      return { versionTypeId, version, id: parent.id, created: true };
    });
  },

  versionTypeExists(versionTypeId) {
    return Boolean(this.db.prepare('SELECT 1 FROM version_types WHERE id = ?').get(versionTypeId));
  },

  listVersionTypes() {
    const result = this.db.prepare('SELECT id, title FROM version_types ORDER BY id').all()
      .map((row) => ({ id: publicHistoryText(row.id), title: publicHistoryText(row.title) }));
    assertPublicHistorySafe(result);
    return result;
  },

  listVersionHistory({ versionTypeId = null, limit, cursor = null }) {
    const clauses = [];
    const params = [];
    if (versionTypeId) {
      clauses.push('build_versions.version_type_id = ?');
      params.push(versionTypeId);
    }
    if (cursor) {
      clauses.push('(build_versions.released_at_utc, build_versions.id) < (?, ?)');
      params.push(cursor.releasedAtUtc, cursor.id);
    }
    const rows = this.db.prepare(`
      SELECT build_versions.*, release_works.work_key, release_works.status AS work_status,
        release_works.created_at_utc AS work_created_at_utc,
        release_works.updated_at_utc AS work_updated_at_utc,
        release_works.finalized_at_utc AS work_finalized_at_utc
      FROM build_versions
      LEFT JOIN release_works ON release_works.id = build_versions.release_works_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY build_versions.released_at_utc DESC, build_versions.id DESC
      LIMIT ?
    `).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (!page.length) return { items: [], hasMore: false };
    const ids = page.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    const details = this.db.prepare(`
      SELECT * FROM build_version_details
      WHERE build_versions_id IN (${placeholders})
      ORDER BY build_versions_id, display_order
    `).all(...ids);
    const pulls = this.db.prepare(`
      SELECT links.build_versions_id, github_pull_requests.*
      FROM build_version_pull_requests AS links
      JOIN github_pull_requests ON github_pull_requests.id = links.github_pull_requests_id
      WHERE links.build_versions_id IN (${placeholders})
      ORDER BY links.build_versions_id, github_pull_requests.github_merged_at_utc, github_pull_requests.pull_number
    `).all(...ids);
    const refs = this.db.prepare(`
      SELECT refs.*, versions.id AS build_versions_id
      FROM build_version_refs AS refs
      JOIN build_versions AS versions
        ON versions.version_type_id = refs.version_type_id AND versions.version = refs.version
      WHERE versions.id IN (${placeholders})
      ORDER BY refs.id
    `).all(...ids);
    const result = {
      items: page.map((row) => publicVersionRow(
        row,
        details.filter((detail) => detail.build_versions_id === row.id),
        pulls.filter((pull) => pull.build_versions_id === row.id),
        refs.filter((ref) => ref.build_versions_id === row.id),
      )),
      hasMore,
    };
    assertPublicHistorySafe(result);
    return result;
  },
};

function publicVersionRow(row, details, pulls, refs) {
  return {
    id: row.id,
    type: row.version_type_id,
    version: row.version,
    short_changes: publicHistoryText(row.short_changes),
    detailed_changes: publicHistoryText(row.detailed_changes),
    reason: publicHistoryText(row.reason),
    released_at_utc: row.released_at_utc,
    created_at_utc: row.created_at_utc,
    work: row.work_key ? {
      key: row.work_key,
      status: row.work_status,
      created_at_utc: row.work_created_at_utc,
      updated_at_utc: row.work_updated_at_utc,
      finalized_at_utc: row.work_finalized_at_utc,
    } : null,
    details: details.map((detail) => ({
      id: detail.id,
      title: publicHistoryText(detail.title),
      description: publicHistoryText(detail.description),
      display_order: detail.display_order,
      pull_request_id: detail.github_pull_requests_id,
    })),
    pull_requests: pulls.map((pull) => ({
      id: pull.id,
      role: pull.work_role,
      repository: pull.repository,
      number: pull.pull_number,
      url: publicHistoryText(pull.url),
      title: publicHistoryText(pull.title),
      body: publicHistoryText(pull.body),
      author_login: pull.author_login,
      state: pull.state,
      is_draft: pull.is_draft,
      head_branch: publicHistoryText(pull.head_branch),
      base_branch: publicHistoryText(pull.base_branch),
      merge_commit_sha: pull.merge_commit_sha,
      created_at_utc: pull.github_created_at_utc,
      updated_at_utc: pull.github_updated_at_utc,
      closed_at_utc: pull.github_closed_at_utc,
      merged_at_utc: pull.github_merged_at_utc,
    })),
    refs: refs.map((ref) => ({
      source_branch: publicHistoryText(ref.source_branch),
      source_commit: ref.source_commit,
      target_branch: publicHistoryText(ref.target_branch),
      target_commit: ref.target_commit,
      created_at_utc: ref.created_at_utc,
    })),
  };
}

function inTransaction(store, operation) {
  return store.db.currentTxId ? operation() : store.db.transaction(operation)();
}

function assertExistingVersion(store, version, work, input, details, requestedPulls) {
  if (input.version != null && version.version !== positiveInteger(input.version, 'version')) {
    throw new Error(`existing ${version.version_type_id} ${version.version} has a different explicit version`);
  }
  const expected = {
    short_changes: requiredText(input.shortChanges, 'short_changes'),
    detailed_changes: requiredText(input.detailedChanges, 'detailed_changes'),
    reason: requiredText(input.reason, 'reason'),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (version[field] !== value) throw new Error(`existing ${version.version_type_id} ${version.version} has different ${field}`);
  }
  const actualDetails = store.db.prepare(`
    SELECT details.title, details.description, pulls.pull_number
    FROM build_version_details AS details
    LEFT JOIN github_pull_requests AS pulls ON pulls.id = details.github_pull_requests_id
    WHERE details.build_versions_id = ?
    ORDER BY details.display_order
  `).all(version.id).map((detail) => ({
    title: detail.title,
    description: detail.description,
    pullNumber: detail.pull_number ?? null,
  }));
  if (JSON.stringify(actualDetails) !== JSON.stringify(details)) {
    throw new Error(`existing ${version.version_type_id} ${version.version} has different details`);
  }
  const actualPulls = store.db.prepare(`
    SELECT pulls.pull_number
    FROM build_version_pull_requests AS links
    JOIN github_pull_requests AS pulls ON pulls.id = links.github_pull_requests_id
    WHERE links.build_versions_id = ?
    ORDER BY pulls.pull_number
  `).all(version.id).map((row) => row.pull_number);
  const expectedPulls = [...requestedPulls].sort((left, right) => left - right);
  if (JSON.stringify(actualPulls) !== JSON.stringify(expectedPulls)) {
    throw new Error(`existing ${version.version_type_id} ${version.version} has different PR links`);
  }
  if (version.version_type_id === 'build' && work.status !== 'finalized') {
    throw new Error(`existing build ${version.version} belongs to non-finalized work ${work.work_key}`);
  }
  if (input.targetBranch && input.targetCommit) {
    const ref = store.db.prepare(`
      SELECT 1 FROM build_version_refs
      WHERE version_type_id = ? AND version = ? AND target_branch = ? AND target_commit = ?
    `).get(version.version_type_id, version.version, input.targetBranch, input.targetCommit);
    if (!ref) throw new Error(`existing ${version.version_type_id} ${version.version} has different target ref`);
  }
}

function requiredWork(store, workKey, { forUpdate = false } = {}) {
  const work = store.db.prepare(`
    SELECT * FROM release_works WHERE work_key = ?${forUpdate ? ' FOR UPDATE' : ''}
  `).get(requiredText(workKey, 'work_key'));
  if (!work) throw new Error(`unknown release work: ${workKey}`);
  if (work.status === 'cancelled') throw new Error(`release work is cancelled: ${workKey}`);
  return work;
}

function requiredPull(store, workId, repository, pullNumber) {
  const pull = store.db.prepare(`
    SELECT * FROM github_pull_requests WHERE release_works_id = ? AND repository = ? AND pull_number = ?
  `).get(workId, repository, positiveInteger(pullNumber, 'pull_number'));
  if (!pull) throw new Error(`unknown work PR: ${repository}#${pullNumber}`);
  return pull;
}

function normalizeDetails(details) {
  if (!Array.isArray(details) || !details.length) throw new Error('version requires at least one detail');
  return details.map((detail) => ({
    title: requiredText(detail?.title, 'detail.title'),
    description: requiredText(detail?.description, 'detail.description'),
    pullNumber: detail?.pullNumber == null ? null : positiveInteger(detail.pullNumber, 'detail.pull_number'),
  }));
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function nullableText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer`);
  return number;
}
