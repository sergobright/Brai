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
    prNumber,
    sourceBranch,
    sourceCommit,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  }) {
    const buildVersion = Number(prNumber);
    if (!Number.isInteger(buildVersion) || buildVersion <= 0) {
      throw new Error(`invalid accepted PR number: ${prNumber}`);
    }
    const version = `0.0.${buildVersion}.1`;
    const now = new Date().toISOString();
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
        "build",
        0,
        0,
        buildVersion,
        1,
        version,
        `Accepted PR #${buildVersion} into dev.`,
        `Recorded accepted PR #${buildVersion}: ${sourceBranch}@${sourceCommit} promoted to ${targetBranch}@${targetCommit}. ${sourceDetails}`,
        `Accepted PR #${buildVersion} into dev.`,
        releasedAtUtc,
        now,
      );

    const ledger = this.db
      .prepare(`
        SELECT COUNT(*) AS count, MAX(build_version) AS max
        FROM build_versions
        WHERE version_type_id = 'build'
      `)
      .get();
    if (ledger.count !== buildVersion || ledger.max !== buildVersion) {
      throw new Error(`build_versions ledger mismatch: expected ${buildVersion} build rows ending at ${buildVersion}, got ${ledger.count} ending at ${ledger.max}`);
    }
  },
};
