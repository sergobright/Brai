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
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetCommit, releaseOnly: false });
    const buildVersion = existing?.build_version ?? this.nextAcceptedBuildVersion();
    const version = `0.0.${buildVersion}.1`;
    const shortChanges = usefulChanges(sourceShortChanges) || `Accepted ${sourceBranch}.`;
    const detailedChanges = usefulChanges(sourceDetails) || shortChanges;
    this.upsertBuildVersion({
      majorVersion: 0,
      releaseVersion: 0,
      buildVersion,
      apkVersion: 1,
      version,
      shortChanges,
      detailedChanges,
      reason: `Accepted dev build ${version}: ${sourceBranch}@${sourceCommit} -> ${targetBranch}@${targetCommit}.`,
      releasedAtUtc,
    });
    return { buildVersion, version };
  },

  recordProductionReleaseVersion({
    sourceBranch,
    sourceCommit,
    sourceShortChanges = null,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const existing = this.findBuildVersionByTargetCommit({ targetCommit, releaseOnly: true });
    if (existing) {
      return {
        releaseVersion: existing.release_version,
        buildVersion: existing.build_version,
        version: existing.version,
      };
    }
    const acceptedBuilds = this.db
      .prepare(`
        SELECT *
        FROM build_versions
        WHERE version_type_id = 'build' AND release_version = 0
        ORDER BY build_version
      `)
      .all();
    const latest = acceptedBuilds.at(-1);
    if (!latest) throw new Error('cannot create production release without accepted dev builds');

    const previousRelease = this.db
      .prepare(`
        SELECT release_version, build_version
        FROM build_versions
        WHERE version_type_id = 'build' AND release_version > 0
        ORDER BY release_version DESC
        LIMIT 1
      `)
      .get() ?? { release_version: 0, build_version: 0 };
    const releaseVersion = previousRelease.release_version + 1;
    const includedBuilds = acceptedBuilds.filter((row) => row.build_version > previousRelease.build_version);
    const referencedBuilds = includedBuilds.length > 0 ? includedBuilds : [latest];
    const version = `0.${releaseVersion}.${latest.build_version}.${latest.apk_version}`;
    const sourceChanges = usefulChanges(sourceDetails);

    this.upsertBuildVersion({
      majorVersion: 0,
      releaseVersion,
      buildVersion: latest.build_version,
      apkVersion: latest.apk_version,
      version,
      shortChanges: usefulChanges(sourceShortChanges) || `Production release ${version}.`,
      detailedChanges: [
        `Included accepted dev builds: ${referencedBuilds.map((row) => `${row.version}: ${row.short_changes}`).join('; ')}.`,
        sourceChanges,
      ].filter(Boolean).join(' '),
      reason: `Promoted dev to production release ${version}: ${sourceBranch}@${sourceCommit || 'unknown'} -> ${targetBranch}@${targetCommit}.`,
      releasedAtUtc,
    });
    return { releaseVersion, buildVersion: latest.build_version, version };
  },

  findBuildVersionByTargetCommit({ targetCommit, releaseOnly }) {
    if (!targetCommit) return null;
    const releaseFilter = releaseOnly ? 'release_version > 0' : 'release_version = 0';
    return this.db
      .prepare(`
        SELECT *
        FROM build_versions
        WHERE version_type_id = 'build'
          AND (instr(detailed_changes, ?) > 0 OR instr(reason, ?) > 0)
          AND ${releaseFilter}
        ORDER BY release_version DESC, build_version DESC
        LIMIT 1
      `)
      .get(`@${targetCommit}`, `@${targetCommit}`);
  },

  nextAcceptedBuildVersion() {
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(build_version), 0) + 1 AS next
        FROM build_versions
        WHERE version_type_id = 'build' AND release_version = 0
      `)
      .get();
    return row.next;
  },

  upsertBuildVersion({
    majorVersion,
    releaseVersion,
    buildVersion,
    apkVersion,
    version,
    shortChanges,
    detailedChanges,
    reason,
    releasedAtUtc,
  }) {
    this.db
      .prepare(`
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
        ON CONFLICT(version_type_id, version) DO UPDATE SET
          short_changes = excluded.short_changes,
          detailed_changes = excluded.detailed_changes,
          reason = excluded.reason,
          released_at_utc = excluded.released_at_utc
      `)
      .run(
        'build',
        majorVersion,
        releaseVersion,
        buildVersion,
        apkVersion,
        version,
        shortChanges,
        detailedChanges,
        reason,
        releasedAtUtc,
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
  if (/^Accepted \S+@\S+ without preview deployment metadata\.?$/i.test(oneLine)) return '';
  return text;
}
