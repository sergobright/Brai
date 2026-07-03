export const deploymentMethods = {
  recordDeployment({
    environment,
    slot = null,
    branch,
    commit,
    domain,
    webOtaVersion = null,
    apkVersion = null,
    shortChanges,
    detailedChanges,
    reason,
    deployedAtUtc,
  }) {
    this.db
      .prepare(`
        INSERT INTO deployment_records (
          environment,
          slot,
          branch,
          commit_sha,
          domain,
          web_ota_version,
          apk_version,
          short_changes,
          detailed_changes,
          reason,
          deployed_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        environment,
        slot,
        branch,
        commit,
        domain,
        webOtaVersion,
        apkVersion,
        shortChanges,
        detailedChanges,
        reason,
        deployedAtUtc,
        new Date().toISOString(),
      );
  },

  listDeploymentRecords({ environment = null } = {}) {
    if (environment) {
      return this.db
        .prepare("SELECT * FROM deployment_records WHERE environment = ? ORDER BY deployed_at_utc DESC, id DESC")
        .all(environment);
    }
    return this.db.prepare("SELECT * FROM deployment_records ORDER BY deployed_at_utc DESC, id DESC").all();
  },

  recordAcceptedBuildVersion({
    sourceBranch = null,
    sourceCommit = null,
    sourceShortChanges,
    sourceDetails,
    sourceReason,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId: 'build' });
    if (existing) return { versionTypeId: 'build', version: existing.version };
    const version = this.nextVersion('build');
    this.upsertBuildVersion({
      versionTypeId: 'build',
      version,
      includedInVersionId: null,
      shortChanges: requireLedgerText(sourceShortChanges, 'short_changes'),
      detailedChanges: requireLedgerText(sourceDetails, 'detailed_changes'),
      reason: requireLedgerText(sourceReason, 'reason'),
      releasedAtUtc,
      sourceBranch,
      sourceCommit,
      targetBranch,
      targetCommit,
    });
    return { versionTypeId: 'build', version };
  },

  recordShippedApkVersion({
    version,
    versionCode,
    sourceBranch = null,
    sourceCommit = null,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId: 'apk' });
    if (existing) return { versionTypeId: 'apk', version: existing.version };
    this.upsertBuildVersion({
      versionTypeId: 'apk',
      version,
      includedInVersionId: null,
      shortChanges: `APK-сборка ${version}.`,
      detailedChanges: `Опубликована Android APK-сборка ${version} с versionCode ${versionCode}.`,
      reason: 'Нужно зафиксировать публичную Android APK-сборку.',
      releasedAtUtc,
      sourceBranch,
      sourceCommit,
      targetBranch,
      targetCommit,
    });
    return { versionTypeId: 'apk', version };
  },

  recordReleaseVersion() {
    throw new Error('release version rows are disabled');
  },

  recordCanonVersion() {
    throw new Error('canon version rows are disabled');
  },

  findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId }) {
    if (!targetCommit) return null;
    const fromRef = this.db
      .prepare(`
        SELECT build_versions.*
        FROM build_version_refs
        JOIN build_versions
          ON build_versions.version_type_id = build_version_refs.version_type_id
         AND build_versions.version = build_version_refs.version
        WHERE build_version_refs.version_type_id = ?
          AND build_versions.version_type_id = ?
          AND build_version_refs.target_branch = ?
          AND build_version_refs.target_commit = ?
        ORDER BY build_versions.version DESC
        LIMIT 1
      `)
      .get(versionTypeId, versionTypeId, targetBranch || '', targetCommit);
    if (fromRef) return fromRef;

    return this.db
      .prepare(`
        SELECT *
        FROM build_versions
        WHERE version_type_id = ?
          AND (instr(detailed_changes, ?) > 0 OR instr(reason, ?) > 0)
        ORDER BY version DESC
        LIMIT 1
      `)
      .get(versionTypeId, `@${targetCommit}`, `@${targetCommit}`);
  },

  nextVersion(versionTypeId) {
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next
        FROM build_versions
        WHERE version_type_id = ?
      `)
      .get(versionTypeId);
    return row.next;
  },

  latestVersion(versionTypeId) {
    return this.db
      .prepare("SELECT * FROM build_versions WHERE version_type_id = ? ORDER BY version DESC LIMIT 1")
      .get(versionTypeId);
  },

  currentAppVersion() {
    const apk = this.latestVersion('apk');
    const build = this.latestVersion('build');
    const latest = { canon: null, release: null, build: build ? formatBuildVersionRow(build) : null, apk: apk ? formatBuildVersionRow(apk) : null };
    const parts = {
      canon: 0,
      release: 0,
      build: build?.version ?? 0,
      apk: apk?.version ?? 0,
    };

    return {
      version: `0.0.${parts.build}`,
      parts,
      latest,
    };
  },

  upsertBuildVersion({
    versionTypeId,
    version,
    includedInVersionId,
    shortChanges,
    detailedChanges,
    reason,
    releasedAtUtc,
    sourceBranch = null,
    sourceCommit = null,
    targetBranch = null,
    targetCommit = null,
  }) {
    this.db
      .prepare(`
        INSERT INTO build_versions (
          version_type_id,
          version,
          included_in_version_id,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO UPDATE SET
          included_in_version_id = excluded.included_in_version_id,
          short_changes = excluded.short_changes,
          detailed_changes = excluded.detailed_changes,
          reason = excluded.reason,
          released_at_utc = excluded.released_at_utc
      `)
      .run(
        versionTypeId,
        version,
        includedInVersionId,
        shortChanges,
        detailedChanges,
        reason,
        releasedAtUtc,
        new Date().toISOString(),
      );
    if (targetBranch && targetCommit) {
      this.upsertBuildVersionRef({
        versionTypeId,
        version,
        sourceBranch,
        sourceCommit,
        targetBranch,
        targetCommit,
      });
    }
  },

  upsertBuildVersionRef({
    versionTypeId,
    version,
    sourceBranch,
    sourceCommit,
    targetBranch,
    targetCommit,
  }) {
    this.db
      .prepare(`
        INSERT INTO build_version_refs (
          version_type_id,
          version,
          source_branch,
          source_commit,
          target_branch,
          target_commit,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, target_branch, target_commit) DO UPDATE SET
          version = excluded.version,
          source_branch = excluded.source_branch,
          source_commit = excluded.source_commit
      `)
      .run(
        versionTypeId,
        version,
        sourceBranch,
        sourceCommit,
        targetBranch,
        targetCommit,
        new Date().toISOString(),
      );
  },
};

function formatBuildVersionRow(row) {
  return {
    id: row.id,
    version_type_id: row.version_type_id,
    version: row.version,
    included_in_version_id: row.included_in_version_id,
    short_changes: row.short_changes,
    detailed_changes: row.detailed_changes,
    reason: row.reason,
    released_at_utc: row.released_at_utc,
    created_at_utc: row.created_at_utc,
  };
}

function requireLedgerText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`missing accepted build ${field}`);
  return text;
}
