#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertPublicHistorySafe, publicHistoryText as redactPublicHistoryText } from "../../services/brai_api/src/public-history-safety.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");
const DEFAULT_MANIFEST = path.join(root, "supabase/backfills/version-history-20260714.json");
const DEFAULT_REPORT = path.join(root, "supabase/backfills/version-history-20260714-report.json");
const REPOSITORY = "sergobright/Brai";
const EXPECTED_VERSIONS = 156;
const EXPECTED_MERGED_PULLS = 277;
const BACKFILL_LOCK = [20260714, 1];

const APK_NOTES = new Map([
  [1, {
    short_changes: "Первый Android-контейнер Brai",
    reason: "Нужен базовый Android-пакет с системными разрешениями, services и native bridge Brai.",
    details: [
      "Android-пакет объявляет AccessibilityService, overlay, уведомления, микрофон и foreground MediaProjection service.",
      "Capacitor-контейнер связывает Android-возможности с пользовательской частью Brai."
    ]
  }],
  [2, {
    short_changes: "Stable и Preview APK получили явную совместимость OTA",
    reason: "Native-контейнер должен принимать только OTA, предназначенный для его release key, build kind и versionCode.",
    details: [
      "Gradle записывает в APK release key, stable/preview build kind, preview iteration, label и отдельный package suffix.",
      "BraiOtaManager и BraiOtaManifest проверяют release key, build kind, preview iteration и target versionCode до применения OTA."
    ]
  }],
  [3, {
    short_changes: "Android и OTA переведены на домены brai.one",
    reason: "Установленный Android-контейнер должен обращаться только к каноническим API и OTA endpoints Brai.",
    details: [
      "Production, Dev и Preview Android flavors используют API и OTA channels на brai.one.",
      "Production APK получает OTA manifest с app.brai.one, а environment flavors — со своих brai.one endpoints."
    ]
  }],
  [4, {
    short_changes: "Добавлен native onboarding и управляемый Brai Cmd overlay",
    reason: "Onboarding, доступ к Brai Cmd и контекстные Android-действия требуют изменений внутри устанавливаемого пакета.",
    details: [
      "MainActivity запускает Android-контейнер с устойчивым тёмным фоном и сохраняемым voice-only onboarding state.",
      "Native plugin получает доступ, сохраняет credential и синхронизирует onboarding с Android-состоянием.",
      "Overlay получил контекстные действия, haptics, queue badges и отдельные настройки доступности."
    ]
  }],
  [5, {
    short_changes: "Android поддерживает preliminary-профиль Brai Cmd",
    reason: "Пользователь должен получить native Brai Cmd до email-регистрации без обхода device-bound ограничений.",
    details: [
      "Android хранит preliminary user id и claim token рядом с device credential.",
      "Native bridge создаёт preliminary-профиль по display name и fingerprint и обрабатывает duplicate-device отказ.",
      "NetworkClient передаёт device identity при первичном доступе и подготовке профиля."
    ]
  }],
  [6, {
    short_changes: "Усилен fail-closed Android onboarding Brai Cmd",
    reason: "Native onboarding не должен продолжаться с рассинхронизированным credential или после preliminary-ошибки.",
    details: [
      "BraiCmdPlugin синхронизирует retry-состояние onboarding с результатом native credential setup.",
      "NetworkClient сохраняет fail-closed поведение при ошибке preliminary-профиля и допускает явный повтор."
    ]
  }],
  [7, {
    short_changes: "Усилены native очередь, провайдеры и выход из Brai Cmd",
    reason: "Очередь и provider-вызовы должны переживать повторы без потери результата, фоновых платных дублей и разблокировки после выхода.",
    details: [
      "DurableQueue сохраняет результат расшифровки между повторами и различает retryable и terminal transport failures.",
      "Provider clients и NetworkClient корректно классифицируют 4xx, 429 и 5xx и останавливают повторы при неверном ключе.",
      "ConfigStore, SecureStringStore и bridge удерживают locked-состояние после выхода и защищаются от поздних WebView-ответов.",
      "RecordingService и RecordingArchiveStore сохраняют WAV-диагностику и checkpoint расшифровки."
    ]
  }],
  [8, {
    short_changes: "Brai Cmd восстанавливает native credential и показывает состояние доставки",
    reason: "Android credential должен восстанавливаться после 401 без гонок, а overlay — честно показывать очередь и доступность обновления.",
    details: [
      "Native 401 запускает credential refresh, не ротируя рабочий device token при каждом online/foreground событии.",
      "Brai Cmd bridge публикует device, client version и package metadata для согласованного восстановления доступа.",
      "Overlay показывает environment marker, update indicator и отдельные состояния очереди."
    ]
  }],
  [9, {
    short_changes: "Исправлены native индикаторы очереди, обновления и completion sound",
    reason: "Android overlay и widget должны показывать только актуальный transport/update state и подтверждать завершение действия.",
    details: [
      "Floating buttons считают только failed audio items своего действия и не показывают update dot во время проверки.",
      "Overlay не смешивает progress проверки обновления с доступным APK или OTA update.",
      "Android widget воспроизводит bundled completion sound после перехода действия в Done."
    ]
  }],
  [10, {
    short_changes: "Android умеет скачать и передать новый APK системному installer",
    reason: "Переход на новый native versionCode нельзя выполнить через web OTA; установленному контейнеру нужен безопасный APK download/install flow.",
    details: [
      "AndroidManifest разрешает запрос установки пакетов, а FileProvider выдаёт installer безопасный content URI.",
      "BraiOtaManager скачивает APK во временный файл с bounded size и восстанавливает interrupted download state.",
      "Native state публикует download progress, install readiness и необходимость REQUEST_INSTALL_PACKAGES permission."
    ]
  }],
  [11, {
    short_changes: "Android credentials, bridge, queue, network и recording обновлены в APK v11",
    reason: "APK v11 публикует native-изменения PR #279; более поздний infra PR #282 не мог войти в уже опубликованный пакет.",
    details: [
      "SecureStringStore, ConfigStore и CredentialOperationSequencer последовательно сохраняют и обновляют provider credentials.",
      "BraiCmdBridge и BraiCmdPlugin передают native provider profiles и credential operations между Android и WebView.",
      "DurableQueue, QueueTransportWorker и NetworkClient восстанавливают auth-blocked и provider failure сценарии без потери очереди.",
      "PendingTranscriptStore и RecordingArchiveStore сохраняют checkpoint расшифровки и диагностические записи между повторами.",
      "RecordingService и OverlayRecordingCoordinator согласуют recording lifecycle с очередью и восстановлением приложения."
    ]
  }]
]);

export async function generateManifest({
  databaseUrl,
  databaseEvidence,
  githubEvidence,
  githubToken = process.env.GITHUB_TOKEN,
  capturedAtUtc = new Date().toISOString(),
  releasesRoot = process.env.BRAI_RELEASES_ROOT || path.join(root, "deploy/releases")
} = {}) {
  const database = databaseEvidence || await readDatabaseEvidence(databaseUrl);
  const observedClosedPulls = githubEvidence || await fetchClosedPulls(githubToken);
  const closedPulls = observedClosedPulls.filter((pull) => pull.closed_at && pull.closed_at <= capturedAtUtc);
  const mergedPulls = closedPulls.filter((pull) => pull.merged_at && pull.merged_at <= capturedAtUtc);
  if (database.versions.length !== EXPECTED_VERSIONS) {
    throw new Error(`expected ${EXPECTED_VERSIONS} cutoff versions, got ${database.versions.length}`);
  }
  if (mergedPulls.length !== EXPECTED_MERGED_PULLS) {
    throw new Error(`expected ${EXPECTED_MERGED_PULLS} merged cutoff PRs, got ${mergedPulls.length}`);
  }

  const pullsByNumber = new Map(mergedPulls.map((pull) => [pull.number, pull]));
  const refsByVersion = Map.groupBy(database.refs, (ref) => versionKey(ref.version_type_id, ref.version));
  const pullNumbersByVersion = new Map();
  for (const [key, refs] of refsByVersion) {
    const matches = new Set();
    for (const ref of refs) {
      const pull = await pullForCommit(ref.target_commit, mergedPulls, githubToken);
      if (!pull) throw new Error(`no PR evidence for ${key} ref ${ref.target_commit}`);
      matches.add(pull.number);
    }
    if (matches.size !== 1) throw new Error(`${key} resolves to several PRs: ${[...matches].join(", ")}`);
    pullNumbersByVersion.set(key, [...matches]);
  }

  const apk11 = database.versions.find((row) => row.version_type_id === "apk" && row.version === 11);
  const apk11Refs = refsByVersion.get("apk:11") || [];
  const pull279 = pullsByNumber.get(279);
  const pull282 = pullsByNumber.get(282);
  if (!apk11 || apk11Refs.length !== 1 || !pull279 || !pull282) throw new Error("APK v11 correction evidence is incomplete");
  const artifact = apk11ArtifactEvidence(releasesRoot);
  if (artifact.published_at_utc !== apk11.released_at_utc || artifact.embedded_build !== "0.0.142") {
    throw new Error("APK v11 artifact does not match the production version row and embedded build 0.0.142");
  }
  if (!(artifact.published_at_utc < pull279.merged_at && pull279.merged_at < pull282.created_at)) {
    throw new Error("APK v11/PR #279/#282 chronology does not prove the correction");
  }
  pullNumbersByVersion.set("apk:11", [279]);

  const versions = database.versions.map((row) => {
    const key = versionKey(row.version_type_id, row.version);
    const pullNumbers = pullNumbersByVersion.get(key) || [];
    const releaseWorkKey = pullNumbers.length ? workKey(pullNumbers[0]) : null;
    const parent = normalizedParent(row);
    const details = normalizedDetails(row, pullNumbers[0] || null);
    const refs = (refsByVersion.get(key) || []).map(publicRef);
    if (key === "apk:11") {
      refs.splice(0, refs.length, {
        source_branch: pull279.head.ref,
        source_commit: pull279.head.sha,
        target_branch: "main",
        target_commit: pull279.merge_commit_sha,
        created_at_utc: apk11Refs[0].created_at_utc
      });
    }
    return {
      version_type_id: row.version_type_id,
      version: Number(row.version),
      release_work_key: releaseWorkKey,
      parent,
      details,
      pull_requests: pullNumbers.map((pullNumber) => ({ repository: REPOSITORY, pull_number: pullNumber })),
      refs
    };
  });

  const buildFinalizedAt = new Map(
    versions
      .filter((version) => version.version_type_id === "build" && version.release_work_key)
      .map((version) => [version.release_work_key, version.parent.released_at_utc])
  );
  const pullRequests = mergedPulls
    .sort((a, b) => a.number - b.number)
    .map((pull) => publicPullSnapshot(pull));
  const releaseWorks = pullRequests.map((pull) => {
    const finalizedAtUtc = buildFinalizedAt.get(pull.work_key) || null;
    return {
      work_key: pull.work_key,
      status: finalizedAtUtc ? "finalized" : "active",
      created_at_utc: pull.github_created_at_utc,
      updated_at_utc: maxTimestamp(pull.github_updated_at_utc, finalizedAtUtc),
      finalized_at_utc: finalizedAtUtc
    };
  });
  const linkedPulls = new Set(versions.flatMap((version) => version.pull_requests.map((pull) => pull.pull_number)));
  const versionsWithoutPulls = versions
    .filter((version) => version.pull_requests.length === 0)
    .map((version) => ({ version_type_id: version.version_type_id, version: version.version }));
  const unlinkedPulls = pullRequests
    .filter((pull) => !linkedPulls.has(pull.pull_number))
    .map((pull) => pull.pull_number);

  const manifest = {
    schema_version: 1,
    cutoff: {
      captured_at_utc: capturedAtUtc,
      database: {
        source: "production-read-only",
        version_count: versions.length,
        version_counts: countBy(versions, (version) => version.version_type_id),
        ref_count: database.refs.length,
        latest_released_at_utc: versions.map((version) => version.parent.released_at_utc).sort().at(-1)
      },
      github: {
        repository: REPOSITORY,
        closed_pull_count: closedPulls.length,
        merged_pull_count: pullRequests.length,
        latest_merged_at_utc: pullRequests.map((pull) => pull.github_merged_at_utc).sort().at(-1)
      }
    },
    evidence_policy: {
      accepted_relationships: ["existing exact build ref to GitHub merge SHA", "existing exact build ref to GitHub head SHA", "GitHub commit association"],
      rejected_relationships: ["timestamp adjacency", "nearby PR number", "Git ancestry range"],
      historical_work_key: "legacy:pr:sergobright/Brai:<pull_number>"
    },
    release_works: releaseWorks,
    pull_requests: pullRequests,
    versions,
    corrections: [{
      kind: "apk_pr_and_ref",
      version_type_id: "apk",
      version: 11,
      from_pull_number: 282,
      to_pull_number: 279,
      from_target_commit: pull282.merge_commit_sha,
      to_target_commit: pull279.merge_commit_sha,
      evidence: {
        artifact,
        pull_279_created_at_utc: pull279.created_at,
        pull_279_merged_at_utc: pull279.merged_at,
        pull_282_created_at_utc: pull282.created_at,
        pull_282_merged_at_utc: pull282.merged_at,
        native_diff_scope: "apps/brai_app/android/app/src/main"
      }
    }],
    versions_without_pull_requests: versionsWithoutPulls,
    imported_but_unlinked_pull_requests: unlinkedPulls,
    insufficient_evidence: [
      ...versionsWithoutPulls.map((version) => ({ kind: "version_pull_relationship", ...version, reason: "No exact ref or other direct PR evidence exists at cutoff." })),
      ...Array.from({ length: 8 }, (_, index) => ({ kind: "apk_artifact", version_type_id: "apk", version: index + 1, reason: "Published APK artifact is not retained in the cutoff release directory." }))
    ]
  };
  validateManifest(manifest);
  return manifest;
}

export function buildReport(manifest) {
  validateManifest(manifest);
  const detailCounts = countBy(manifest.versions, (version) => String(version.details.length));
  const linkedPulls = new Set(manifest.versions.flatMap((version) => version.pull_requests.map((pull) => pull.pull_number)));
  return {
    schema_version: 1,
    manifest_sha256: crypto.createHash("sha256").update(jsonText(manifest)).digest("hex"),
    counts: {
      versions: manifest.versions.length,
      versions_by_type: countBy(manifest.versions, (version) => version.version_type_id),
      details: manifest.versions.reduce((sum, version) => sum + version.details.length, 0),
      detail_count_distribution: detailCounts,
      merged_pull_requests_imported: manifest.pull_requests.length,
      linked_pull_requests: linkedPulls.size,
      imported_but_unlinked_pull_requests: manifest.imported_but_unlinked_pull_requests.length,
      versions_without_pull_requests: manifest.versions_without_pull_requests.length,
      refs: manifest.versions.reduce((sum, version) => sum + version.refs.length, 0),
      corrected_refs: manifest.corrections.length,
      insufficient_evidence_items: manifest.insufficient_evidence.length
    },
    versions_without_pull_requests: manifest.versions_without_pull_requests,
    imported_but_unlinked_pull_requests: manifest.imported_but_unlinked_pull_requests,
    corrected_refs: manifest.corrections.map(({ kind, version_type_id, version, from_pull_number, to_pull_number, from_target_commit, to_target_commit }) => ({
      kind, version_type_id, version, from_pull_number, to_pull_number, from_target_commit, to_target_commit
    })),
    insufficient_evidence: manifest.insufficient_evidence
  };
}

export function validateManifest(manifest) {
  if (manifest?.schema_version !== 1) throw new Error("unsupported version-history manifest schema");
  assertPublicHistorySafe(manifest);
  if (!Array.isArray(manifest.release_works) || !Array.isArray(manifest.pull_requests) || !Array.isArray(manifest.versions)) {
    throw new Error("manifest works, pull_requests, and versions are required");
  }
  const workKeys = new Set();
  for (const work of manifest.release_works) {
    if (!requiredText(work.work_key) || workKeys.has(work.work_key)) throw new Error(`duplicate or empty work key: ${work.work_key}`);
    workKeys.add(work.work_key);
  }
  const pulls = new Map();
  for (const pull of manifest.pull_requests) {
    const key = pullKey(pull.repository, pull.pull_number);
    if (pulls.has(key)) throw new Error(`duplicate PR: ${key}`);
    if (!workKeys.has(pull.work_key)) throw new Error(`unknown work for PR ${key}`);
    pulls.set(key, pull);
  }
  const versions = new Set();
  const linkedPullTypes = new Set();
  for (const version of manifest.versions) {
    const key = versionKey(version.version_type_id, version.version);
    if (versions.has(key)) throw new Error(`duplicate version: ${key}`);
    versions.add(key);
    if (!Array.isArray(version.details) || version.details.length === 0) throw new Error(`version ${key} requires at least one detail`);
    if (version.release_work_key && !workKeys.has(version.release_work_key)) throw new Error(`unknown version work: ${key}`);
    const versionPulls = new Set(version.pull_requests.map((pull) => pullKey(pull.repository, pull.pull_number)));
    for (const pull of version.pull_requests) {
      const keyForPull = pullKey(pull.repository, pull.pull_number);
      const snapshot = pulls.get(keyForPull);
      if (!snapshot) throw new Error(`unknown linked PR: ${keyForPull}`);
      if (snapshot.work_key !== version.release_work_key) throw new Error(`PR ${keyForPull} belongs to another work`);
      const typed = `${keyForPull}:${version.version_type_id}`;
      if (linkedPullTypes.has(typed)) throw new Error(`PR ${keyForPull} is linked twice for ${version.version_type_id}`);
      linkedPullTypes.add(typed);
    }
    for (const detail of version.details) {
      if (!requiredText(detail.title) || !requiredText(detail.description)) throw new Error(`empty detail in ${key}`);
      if (detail.pull_number != null && !versionPulls.has(pullKey(REPOSITORY, detail.pull_number))) {
        throw new Error(`detail PR #${detail.pull_number} is not linked to ${key}`);
      }
    }
  }
  return manifest;
}

export async function applyVersionHistoryBackfill(pool, manifest, { beforeCommit } = {}) {
  validateManifest(manifest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", BACKFILL_LOCK);
    const result = await applyInTransaction(client, manifest);
    if (beforeCommit) await beforeCommit(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyInTransaction(client, manifest) {
  const workIds = new Map();
  for (const work of manifest.release_works) {
    const result = await client.query(`
      INSERT INTO release_works (work_key, status, created_at_utc, updated_at_utc, finalized_at_utc)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (work_key) DO UPDATE SET
        status = excluded.status,
        updated_at_utc = excluded.updated_at_utc,
        finalized_at_utc = excluded.finalized_at_utc
      RETURNING id
    `, [work.work_key, work.status, work.created_at_utc, work.updated_at_utc, work.finalized_at_utc]);
    workIds.set(work.work_key, result.rows[0].id);
  }

  const pullIds = new Map();
  for (const pull of manifest.pull_requests) {
    const key = pullKey(pull.repository, pull.pull_number);
    const workId = workIds.get(pull.work_key);
    const existing = await client.query(`
      SELECT release_works_id, work_role FROM github_pull_requests
      WHERE repository = $1 AND pull_number = $2
    `, [pull.repository, pull.pull_number]);
    if (existing.rowCount && (existing.rows[0].release_works_id !== workId || existing.rows[0].work_role !== pull.work_role)) {
      throw new Error(`existing PR membership differs for ${key}`);
    }
    const result = await client.query(`
      INSERT INTO github_pull_requests (
        release_works_id, work_role, repository, pull_number, url, title, body, author_login,
        state, is_draft, head_branch, base_branch, merge_commit_sha,
        github_created_at_utc, github_updated_at_utc, github_closed_at_utc, github_merged_at_utc,
        created_at_utc, updated_at_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (repository, pull_number) DO UPDATE SET
        url=excluded.url, title=excluded.title, body=excluded.body, author_login=excluded.author_login,
        state=excluded.state, is_draft=excluded.is_draft, head_branch=excluded.head_branch,
        base_branch=excluded.base_branch, merge_commit_sha=excluded.merge_commit_sha,
        github_created_at_utc=excluded.github_created_at_utc,
        github_updated_at_utc=excluded.github_updated_at_utc,
        github_closed_at_utc=excluded.github_closed_at_utc,
        github_merged_at_utc=excluded.github_merged_at_utc,
        updated_at_utc=excluded.updated_at_utc
      RETURNING id
    `, [
      workId, pull.work_role, pull.repository, pull.pull_number, pull.url, pull.title, pull.body,
      pull.author_login, pull.state, pull.is_draft, pull.head_branch, pull.base_branch,
      pull.merge_commit_sha, pull.github_created_at_utc, pull.github_updated_at_utc,
      pull.github_closed_at_utc, pull.github_merged_at_utc, pull.created_at_utc, pull.updated_at_utc
    ]);
    pullIds.set(key, result.rows[0].id);
  }

  const versionIds = [];
  for (const version of manifest.versions) {
    const key = versionKey(version.version_type_id, version.version);
    const parentResult = await client.query(`
      SELECT id, released_at_utc, created_at_utc FROM build_versions
      WHERE version_type_id = $1 AND version = $2
    `, [version.version_type_id, version.version]);
    if (parentResult.rowCount !== 1) throw new Error(`cutoff version is missing: ${key}`);
    const parent = parentResult.rows[0];
    if (parent.released_at_utc !== version.parent.released_at_utc || parent.created_at_utc !== version.parent.created_at_utc) {
      throw new Error(`cutoff timestamps differ for ${key}`);
    }
    const workId = version.release_work_key ? workIds.get(version.release_work_key) : null;
    await client.query(`
      UPDATE build_versions SET
        release_works_id=$1, short_changes=$2, detailed_changes=$3, reason=$4
      WHERE id=$5
    `, [workId, version.parent.short_changes, version.parent.detailed_changes, version.parent.reason, parent.id]);

    const existingDetails = await client.query(`
      SELECT id, display_order FROM build_version_details
      WHERE build_versions_id=$1 ORDER BY display_order
    `, [parent.id]);
    const detailIdsByOrder = new Map(existingDetails.rows.map((detail) => [detail.display_order, detail.id]));
    for (const [index, detail] of version.details.entries()) {
      const displayOrder = index + 1;
      const pullId = detail.pull_number == null ? null : pullIds.get(pullKey(REPOSITORY, detail.pull_number));
      const detailId = detailIdsByOrder.get(displayOrder);
      if (detailId) {
        await client.query(`
          UPDATE build_version_details SET github_pull_requests_id=$1, title=$2, description=$3, updated_at_utc=$4
          WHERE id=$5
        `, [pullId, detail.title, detail.description, version.parent.released_at_utc, detailId]);
      } else {
        await client.query(`
          INSERT INTO build_version_details (
            build_versions_id, github_pull_requests_id, title, description, display_order, created_at_utc, updated_at_utc
          ) VALUES ($1,$2,$3,$4,$5,$6,$6)
        `, [parent.id, pullId, detail.title, detail.description, displayOrder, version.parent.released_at_utc]);
      }
    }
    await client.query("DELETE FROM build_version_details WHERE build_versions_id=$1 AND display_order>$2", [parent.id, version.details.length]);

    const desiredPullIds = version.pull_requests.map((pull) => pullIds.get(pullKey(pull.repository, pull.pull_number)));
    for (const pullId of desiredPullIds) {
      await client.query(`
        INSERT INTO build_version_pull_requests (build_versions_id, version_type_id, github_pull_requests_id, created_at_utc)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (build_versions_id, github_pull_requests_id) DO NOTHING
      `, [parent.id, version.version_type_id, pullId, version.parent.released_at_utc]);
    }
    await client.query(`
      DELETE FROM build_version_pull_requests
      WHERE build_versions_id=$1
        AND NOT (github_pull_requests_id = ANY($2::int[]))
    `, [parent.id, desiredPullIds]);

    await syncRefs(client, parent.id, version);
    versionIds.push(parent.id);
  }

  for (const [versionTypeId, maximum] of Object.entries(maxVersionByType(manifest.versions))) {
    await client.query(`
      INSERT INTO build_version_counters (version_type_id, last_version) VALUES ($1,$2)
      ON CONFLICT (version_type_id) DO UPDATE SET
        last_version=GREATEST(build_version_counters.last_version, excluded.last_version)
    `, [versionTypeId, maximum]);
  }
  await validateAppliedRows(client, versionIds);
  return appliedReport(manifest);
}

async function syncRefs(client, buildVersionId, version) {
  const existing = (await client.query(`
    SELECT refs.* FROM build_version_refs AS refs
    JOIN build_versions AS versions
      ON versions.version_type_id=refs.version_type_id AND versions.version=refs.version
    WHERE versions.id=$1 ORDER BY refs.id
  `, [buildVersionId])).rows;
  const unused = [...existing];
  const retained = [];
  for (const ref of version.refs) {
    const exactIndex = unused.findIndex((row) => row.target_branch === ref.target_branch && row.target_commit === ref.target_commit);
    const current = exactIndex >= 0 ? unused.splice(exactIndex, 1)[0] : unused.shift();
    if (current) {
      await client.query(`
        UPDATE build_version_refs SET source_branch=$1, source_commit=$2, target_branch=$3, target_commit=$4, created_at_utc=$5
        WHERE id=$6
      `, [ref.source_branch, ref.source_commit, ref.target_branch, ref.target_commit, ref.created_at_utc, current.id]);
      retained.push(current.id);
    } else {
      const inserted = await client.query(`
        INSERT INTO build_version_refs (
          version_type_id, version, source_branch, source_commit, target_branch, target_commit, created_at_utc
        ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [version.version_type_id, version.version, ref.source_branch, ref.source_commit, ref.target_branch, ref.target_commit, ref.created_at_utc]);
      retained.push(inserted.rows[0].id);
    }
  }
  if (unused.length) await client.query("DELETE FROM build_version_refs WHERE id = ANY($1::int[])", [unused.map((row) => row.id)]);
}

async function validateAppliedRows(client, versionIds) {
  const missingDetails = await client.query(`
    SELECT versions.id FROM build_versions AS versions
    WHERE versions.id=ANY($1::int[])
      AND NOT EXISTS (SELECT 1 FROM build_version_details AS details WHERE details.build_versions_id=versions.id)
  `, [versionIds]);
  if (missingDetails.rowCount) throw new Error(`versions without details: ${missingDetails.rows.map((row) => row.id).join(", ")}`);
  const inconsistent = await client.query(`
    SELECT details.id
    FROM build_version_details AS details
    JOIN build_versions AS versions ON versions.id=details.build_versions_id
    JOIN github_pull_requests AS pulls ON pulls.id=details.github_pull_requests_id
    WHERE versions.id=ANY($1::int[])
      AND (
        versions.release_works_id IS DISTINCT FROM pulls.release_works_id
        OR NOT EXISTS (
          SELECT 1 FROM build_version_pull_requests AS links
          WHERE links.build_versions_id=versions.id
            AND links.version_type_id=versions.version_type_id
            AND links.github_pull_requests_id=pulls.id
        )
      )
  `, [versionIds]);
  if (inconsistent.rowCount) throw new Error(`inconsistent detail provenance: ${inconsistent.rows.map((row) => row.id).join(", ")}`);
}

async function readDatabaseEvidence(databaseUrl) {
  if (!databaseUrl) throw new Error("BRAI_DATABASE_URL is required to generate the manifest");
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const versions = (await client.query(`
      SELECT id, version_type_id, version, included_in_version_id, short_changes, detailed_changes,
        reason, released_at_utc, created_at_utc
      FROM build_versions ORDER BY version_type_id, version
    `)).rows;
    const refs = (await client.query(`
      SELECT id, version_type_id, version, source_branch, source_commit, target_branch, target_commit, created_at_utc
      FROM build_version_refs ORDER BY version_type_id, version, id
    `)).rows;
    await client.query("COMMIT");
    return { versions, refs };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function fetchClosedPulls(token) {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const response = await githubFetch(`/repos/${REPOSITORY}/pulls?state=closed&sort=created&direction=asc&per_page=100&page=${page}`, token);
    pulls.push(...response);
    if (response.length < 100) return pulls;
  }
}

async function pullForCommit(commit, mergedPulls, token) {
  const direct = mergedPulls.filter((pull) => shaMatches(pull.merge_commit_sha, commit) || shaMatches(pull.head?.sha, commit));
  if (direct.length > 1) throw new Error(`ambiguous direct PR evidence for ${commit}`);
  if (direct.length === 1) return direct[0];
  const associated = (await githubFetch(`/repos/${REPOSITORY}/commits/${commit}/pulls`, token))
    .filter((pull) => pull.merged_at);
  if (associated.length > 1) throw new Error(`ambiguous GitHub commit association for ${commit}`);
  return associated[0] || null;
}

async function githubFetch(pathname, token) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "brai-version-history-backfill" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${pathname}`);
  return response.json();
}

function apk11ArtifactEvidence(releasesRoot) {
  const releases = JSON.parse(fs.readFileSync(path.join(releasesRoot, "releases.json"), "utf8"));
  const production = releases.sections?.production;
  if (!production || production.apkVersion !== 11 || production.versionCode !== 11) throw new Error("production APK v11 release metadata is missing");
  const apkPath = path.join(releasesRoot, production.file);
  const bytes = fs.readFileSync(apkPath);
  const embedded = JSON.parse(execFileSync("unzip", ["-p", apkPath, "assets/public/version.json"], { encoding: "utf8" }));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== production.sha256 || bytes.length !== production.sizeBytes) throw new Error("production APK v11 checksum or size differs from releases.json");
  return {
    file: production.file,
    apk_version: production.apkVersion,
    version_code: production.versionCode,
    published_at_utc: production.publishedAt,
    size_bytes: production.sizeBytes,
    sha256,
    embedded_build: embedded.version,
    embedded_android_version_code: embedded.androidVersionCode
  };
}

function normalizedParent(row) {
  const apk = row.version_type_id === "apk" ? APK_NOTES.get(Number(row.version)) : null;
  if (row.version_type_id === "apk" && !apk) throw new Error(`missing native-only APK notes for v${row.version}`);
  return {
    included_in_version: null,
    short_changes: publicHistoryText(apk?.short_changes || row.short_changes),
    detailed_changes: publicHistoryText(apk ? apk.details.join("\n\n") : row.detailed_changes),
    reason: publicHistoryText(apk?.reason || row.reason),
    released_at_utc: row.released_at_utc,
    created_at_utc: row.created_at_utc
  };
}

function normalizedDetails(row, pullNumber) {
  const apk = row.version_type_id === "apk" ? APK_NOTES.get(Number(row.version)) : null;
  const chunks = apk?.details || atomicText(row.detailed_changes);
  const title = publicHistoryText(apk?.short_changes || row.short_changes).replace(/[.!?]+$/u, "");
  return chunks.map((description, index) => ({
    title: chunks.length === 1 ? title : `${title} — ${index + 1}`,
    description: publicHistoryText(description),
    pull_number: pullNumber
  }));
}

function atomicText(value) {
  const text = requiredText(publicHistoryText(value));
  const chunks = text
    .split(/\n\s*\n|\n+|;\s+(?=[\p{Lu}\d])|(?<=[.!?])\s+(?=[\p{Lu}\d])/u)
    .map((part) => part.trim().replace(/^[-*•]\s*/u, ""))
    .filter(Boolean);
  return chunks.length ? chunks : [text];
}

function publicPullSnapshot(pull) {
  return {
    work_key: workKey(pull.number),
    work_role: "owner",
    repository: REPOSITORY,
    pull_number: pull.number,
    url: pull.html_url,
    title: publicHistoryText(pull.title),
    body: publicHistoryText(pull.body || ""),
    author_login: pull.user.login,
    state: String(pull.state).toUpperCase(),
    is_draft: Boolean(pull.draft),
    head_branch: pull.head.ref,
    base_branch: pull.base.ref,
    merge_commit_sha: pull.merge_commit_sha,
    github_created_at_utc: pull.created_at,
    github_updated_at_utc: pull.updated_at,
    github_closed_at_utc: pull.closed_at,
    github_merged_at_utc: pull.merged_at,
    created_at_utc: pull.created_at,
    updated_at_utc: pull.updated_at
  };
}

function publicRef(ref) {
  return {
    source_branch: ref.source_branch,
    source_commit: ref.source_commit,
    target_branch: ref.target_branch,
    target_commit: ref.target_commit,
    created_at_utc: ref.created_at_utc
  };
}

function appliedReport(manifest) {
  const report = buildReport(manifest);
  return { ok: true, manifest_sha256: report.manifest_sha256, ...report.counts };
}

function maxVersionByType(versions) {
  const result = {};
  for (const version of versions) result[version.version_type_id] = Math.max(result[version.version_type_id] || 0, version.version);
  return result;
}

function countBy(rows, keyFor) {
  const result = {};
  for (const row of rows) {
    const key = keyFor(row);
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function maxTimestamp(...values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function workKey(pullNumber) {
  return `legacy:pr:${REPOSITORY}:${pullNumber}`;
}

function versionKey(versionTypeId, version) {
  return `${versionTypeId}:${version}`;
}

function pullKey(repository, pullNumber) {
  return `${repository}#${pullNumber}`;
}

function shaMatches(candidate, evidence) {
  return Boolean(candidate && evidence && (candidate.startsWith(evidence) || evidence.startsWith(candidate)));
}

function requiredText(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("required text is empty");
  return text;
}

function publicHistoryText(value) {
  return redactPublicHistoryText(String(value ?? "").trim());
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jsonText(value));
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) result._.push(value);
    else result[value.slice(2)] = argv[++index];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "generate") {
    const databaseEvidence = args["database-evidence"] ? JSON.parse(fs.readFileSync(args["database-evidence"], "utf8")) : null;
    const githubEvidence = args["github-evidence"] ? JSON.parse(fs.readFileSync(args["github-evidence"], "utf8")) : null;
    const manifest = await generateManifest({
      databaseUrl: process.env.BRAI_DATABASE_URL,
      databaseEvidence,
      githubEvidence,
      capturedAtUtc: args["captured-at"] || new Date().toISOString(),
      releasesRoot: args["releases-root"] || process.env.BRAI_RELEASES_ROOT || path.join(root, "deploy/releases")
    });
    const output = path.resolve(args.output || DEFAULT_MANIFEST);
    const reportPath = path.resolve(args.report || DEFAULT_REPORT);
    writeJson(output, manifest);
    writeJson(reportPath, buildReport(manifest));
    console.log(JSON.stringify({ ok: true, manifest: path.relative(root, output), report: path.relative(root, reportPath), ...buildReport(manifest).counts }));
    return;
  }
  if (command === "apply") {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest || DEFAULT_MANIFEST), "utf8"));
    const databaseUrl = process.env.BRAI_DATABASE_URL || process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("BRAI_DATABASE_URL is required to apply the backfill");
    const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl), max: 1 });
    try {
      console.log(JSON.stringify(await applyVersionHistoryBackfill(pool, manifest)));
    } finally {
      await pool.end();
    }
    return;
  }
  if (command === "report") {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest || DEFAULT_MANIFEST), "utf8"));
    const report = buildReport(manifest);
    if (args.output) writeJson(path.resolve(args.output), report);
    else process.stdout.write(jsonText(report));
    return;
  }
  throw new Error("usage: version-history-backfill.mjs generate|apply|report");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
