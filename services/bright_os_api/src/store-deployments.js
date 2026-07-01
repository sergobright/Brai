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
    sourceBranch,
    sourceCommit,
    sourceShortChanges = null,
    sourceReason = null,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId: 'build' });
    const version = existing?.version ?? this.nextVersion('build');
    const fallbackShortChanges = 'Принята сборка Bright OS.';
    const fallbackDetailedChanges = 'Сборка принята; технические branch/commit-данные сохранены отдельно.';
    const fallbackReason = 'Нужно зафиксировать принятую сборку без смешивания release notes с техническими метаданными.';
    const shortChanges = usefulChanges(sourceShortChanges) || fallbackShortChanges;
    const detailedChanges = usefulChanges(sourceDetails) || (shortChanges === fallbackShortChanges ? fallbackDetailedChanges : shortChanges);
    this.upsertBuildVersion({
      versionTypeId: 'build',
      version,
      includedInVersionId: null,
      shortChanges,
      detailedChanges,
      reason: usefulReason(sourceReason)
        || (shortChanges === fallbackShortChanges ? fallbackReason : '')
        || reasonFromChanges(detailedChanges, shortChanges)
        || 'Нужно зафиксировать принятую сборку.',
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

  recordReleaseVersion({
    sourceBranch,
    sourceCommit,
    sourceShortChanges = null,
    sourceReason = null,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId: 'release' });
    if (existing) return { versionTypeId: 'release', version: existing.version };
    const builds = this.db
      .prepare(`
        SELECT *
        FROM build_versions
        WHERE version_type_id = 'build' AND included_in_version_id IS NULL
        ORDER BY version
      `)
      .all();
    if (builds.length === 0) throw new Error('cannot create release without unlinked builds');
    const version = this.nextVersion('release');
    const sourceChanges = usefulChanges(sourceDetails);

    this.upsertBuildVersion({
      versionTypeId: 'release',
      version,
      includedInVersionId: null,
      shortChanges: usefulChanges(sourceShortChanges) || `Release ${version}.`,
      detailedChanges: [
        `Included builds: ${builds.map((row) => `build ${row.version}: ${row.short_changes}`).join('; ')}.`,
        sourceChanges,
      ].filter(Boolean).join(' '),
      reason: usefulReason(sourceReason) || 'Needed to group accepted builds into a manual release.',
      releasedAtUtc,
      sourceBranch,
      sourceCommit,
      targetBranch,
      targetCommit,
    });
    const release = this.db
      .prepare("SELECT id FROM build_versions WHERE version_type_id = 'release' AND version = ?")
      .get(version);
    const link = this.db.prepare("UPDATE build_versions SET included_in_version_id = ? WHERE id = ?");
    for (const build of builds) link.run(release.id, build.id);
    const apk = this.latestVersion('apk');
    if (apk) link.run(release.id, apk.id);
    return { versionTypeId: 'release', version };
  },

  recordCanonVersion({
    sourceBranch,
    sourceCommit,
    sourceShortChanges = null,
    sourceReason = null,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId: 'canon' });
    if (existing) return { versionTypeId: 'canon', version: existing.version };
    const releases = this.db
      .prepare(`
        SELECT *
        FROM build_versions
        WHERE version_type_id = 'release' AND included_in_version_id IS NULL
        ORDER BY version
      `)
      .all();
    if (releases.length === 0) throw new Error('cannot create canon without unlinked releases');
    const version = this.nextVersion('canon');
    const sourceChanges = usefulChanges(sourceDetails);
    this.upsertBuildVersion({
      versionTypeId: 'canon',
      version,
      includedInVersionId: null,
      shortChanges: usefulChanges(sourceShortChanges) || `Canon ${version}.`,
      detailedChanges: [
        `Included releases: ${releases.map((row) => `release ${row.version}: ${row.short_changes}`).join('; ')}.`,
        sourceChanges,
      ].filter(Boolean).join(' '),
      reason: usefulReason(sourceReason) || 'Needed to group releases into a manual canon.',
      releasedAtUtc,
      sourceBranch,
      sourceCommit,
      targetBranch,
      targetCommit,
    });
    const canon = this.db
      .prepare("SELECT id FROM build_versions WHERE version_type_id = 'canon' AND version = ?")
      .get(version);
    const link = this.db.prepare("UPDATE build_versions SET included_in_version_id = ? WHERE id = ?");
    for (const release of releases) link.run(canon.id, release.id);
    return { versionTypeId: 'canon', version };
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
    const rows = this.db
      .prepare(`
        SELECT build_versions.*
        FROM build_versions
        JOIN (
          SELECT version_type_id, MAX(version) AS version
          FROM build_versions
          GROUP BY version_type_id
        ) latest
          ON latest.version_type_id = build_versions.version_type_id
         AND latest.version = build_versions.version
      `)
      .all();
    const latest = { canon: null, release: null, build: null, apk: null };
    for (const row of rows) {
      if (Object.hasOwn(latest, row.version_type_id)) latest[row.version_type_id] = formatBuildVersionRow(row);
    }
    const parts = {
      canon: latest.canon?.version ?? 0,
      release: latest.release?.version ?? 0,
      build: latest.build?.version ?? 0,
      apk: latest.apk?.version ?? 0,
    };

    return {
      version: `${parts.canon}.${parts.release}.${parts.build}.${parts.apk}`,
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

function usefulChanges(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ');
  if (oneLine === 'Branch deployment') return '';
  if (/^Automated deployment from \S+@\S+ to \S+\.?$/i.test(oneLine)) return '';
  if (/^Automated dev deployment from \S+@\S+\.?$/i.test(oneLine)) return '';
  if (/^Accepted preview branch \S+@\S+\.?$/i.test(oneLine)) return '';
  if (/^Accepted dev build (?:\d|0\.)/i.test(oneLine)) return '';
  if (/^Accepted codex\/\S+\.?$/i.test(oneLine)) return '';
  if (/^Accepted \S+@\S+ without preview deployment metadata\.?$/i.test(oneLine)) return '';
  if (/^Accepted preview changes without authored release notes\.?$/i.test(oneLine)) return '';
  if (/^No authored preview release notes were available; audit metadata is stored separately\.?$/i.test(oneLine)) return '';
  if (!/[А-Яа-яЁё]/.test(oneLine)) return '';
  return text;
}

function usefulReason(value) {
  const text = usefulChanges(value);
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ');
  if (/^Accepted branch promotion\.?$/i.test(oneLine)) return '';
  if (/^Promote preview\b/i.test(oneLine)) return '';
  if (/^Promote dev to production/i.test(oneLine)) return '';
  if (/^Automated branch delivery\.?$/i.test(oneLine)) return '';
  if (/^Automated dev deployment\.?$/i.test(oneLine)) return '';
  return text;
}

function reasonFromChanges(detailedChanges, shortChanges) {
  const text = usefulChanges(detailedChanges) || usefulChanges(shortChanges);
  if (!text) return '';
  return `Нужно: ${text.replace(/\.$/, '')}.`;
}

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
