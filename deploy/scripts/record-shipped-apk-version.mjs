#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";
import { normalizedReleaseReceiptFromPull } from "./accepted-preview-branches.mjs";

const args = parseArgs(process.argv.slice(2));
const apkVersion = apkCounter(required(args, "version"));
const versionCode = required(args, "version-code");
const workKey = required(args, "work-key");
const targetBranch = required(args, "target-branch");
const targetCommit = required(args, "target-commit");
const published = publishedArtifact(apkVersion, versionCode);
const releasedAtUtc = args["released-at"] || published.publishedAt;
if (releasedAtUtc !== published.publishedAt) throw new Error("APK ledger timestamp does not match the published artifact");
const store = new BraiStore(databaseTarget(args));

try {
  const work = store.releaseWork(workKey);
  if (!work) throw new Error(`unknown release work: ${workKey}`);
  const existing = store.db.prepare("SELECT * FROM build_versions WHERE release_works_id = ? AND version_type_id = 'apk'").get(work.id);
  if (existing && existing.version !== apkVersion) throw new Error(`${workKey} already has apk ${existing.version}, not ${apkVersion}`);
  const latest = store.latestVersion("apk");
  const build = store.db.prepare("SELECT * FROM build_versions WHERE release_works_id = ? AND version_type_id = 'build'").get(work.id);
  if (existing) {
    if (build && existing.included_in_version_id == null) {
      store.db.prepare("UPDATE build_versions SET included_in_version_id = ? WHERE id = ? AND included_in_version_id IS NULL").run(build.id, existing.id);
    }
    console.log(`apk ${existing.version} (already recorded)`);
  } else {
    const pulls = store.db.prepare(`
      SELECT * FROM github_pull_requests
      WHERE release_works_id = ? AND (state = 'MERGED' OR github_merged_at_utc IS NOT NULL)
      ORDER BY github_merged_at_utc, pull_number
    `).all(work.id);
    const platformPulls = pulls.flatMap((pull) => {
      const releaseNotes = normalizedReleaseReceiptFromPull(githubPull(pull), pull.head_branch, pull.repository);
      return releaseNotes.platforms?.apk ? [{ pull, apk: releaseNotes.platforms.apk }] : [];
    });
    if (!platformPulls.length) throw new Error(`${workKey} has no merged APK platform metadata`);
    if (latest && latest.version >= apkVersion) throw new Error(`apk ${apkVersion} is not above latest apk ${latest.version}`);
    const owner = platformPulls.find(({ pull }) => pull.work_role === "owner") ?? platformPulls[0];
    const row = store.finalizeVersionWork({
      workKey,
      versionTypeId: "apk",
      version: apkVersion,
      includedInVersionId: build?.id ?? null,
      shortChanges: owner.apk.short_changes,
      detailedChanges: owner.apk.detailed_changes,
      reason: owner.apk.reason,
      details: platformPulls.flatMap(({ pull, apk }) => apk.details.map((detail) => ({ ...detail, pullNumber: pull.pull_number }))),
      pullNumbers: platformPulls.map(({ pull }) => pull.pull_number),
      sourceBranch: args["source-branch"] || null,
      sourceCommit: args["source-commit"] || null,
      targetBranch,
      targetCommit,
      releasedAtUtc,
    });
    console.log(`${row.versionTypeId} ${row.version}`);
  }
} finally {
  store.close();
}

function githubPull(row) {
  return {
    number: row.pull_number,
    html_url: row.url,
    title: row.title,
    body: row.body,
    user: { login: row.author_login },
    state: row.state,
    draft: row.is_draft,
    head: { ref: row.head_branch },
    base: { ref: row.base_branch },
    merge_commit_sha: row.merge_commit_sha,
    created_at: row.github_created_at_utc,
    updated_at: row.github_updated_at_utc,
    closed_at: row.github_closed_at_utc,
    merged_at: row.github_merged_at_utc,
  };
}

function apkCounter(version) {
  const value = Number(version);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid Brai APK version: ${version}`);
  return value;
}

function publishedArtifact(apkVersion, versionCode) {
  const releaseRoot = path.resolve(process.env.BRAI_RELEASE_TARGET || path.resolve(import.meta.dirname, "../releases"));
  const index = JSON.parse(fs.readFileSync(path.join(releaseRoot, "releases.json"), "utf8"));
  const release = index.sections?.production;
  if (release?.apkBuildKind !== "stable" || release.apkVersion !== apkVersion || Number(release.versionCode) !== Number(versionCode)) {
    throw new Error(`published production APK metadata does not match v${apkVersion}/${versionCode}`);
  }
  const file = path.resolve(releaseRoot, required(release, "file"));
  if (!file.startsWith(`${releaseRoot}${path.sep}`) || !fs.existsSync(file)) throw new Error("published production APK file is missing or unsafe");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (sha256 !== release.sha256 || fs.statSync(file).size !== release.sizeBytes) throw new Error("published production APK checksum or size differs from release index");
  return release;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    parsed[key.slice(2)] = values[index + 1] ?? "";
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function databaseTarget(values) {
  return values["postgres-url"] || process.env.BRAI_DATABASE_URL || required(values, "postgres-url");
}
