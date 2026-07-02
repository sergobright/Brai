import type { AppVersionState, VersionTypeId } from "@/shared/api/braiApi";
import type { BraiOtaState } from "@/shared/platform/ota";
import type { Tone } from "../../appModel";

const updateErrorMessages: Record<string, string> = {
  archive_checksum_mismatch: "Файл обновления скачался поврежденным. Запусти проверку еще раз.",
  archive_download_size_exceeded: "Файл обновления оказался больше ожидаемого. Установка остановлена.",
  archive_invalid_zip: "Архив обновления поврежден. Запусти проверку еще раз.",
  archive_path_traversal: "Архив обновления выглядит небезопасно. Установка остановлена.",
  archive_size_mismatch: "Файл обновления скачался не полностью. Запусти проверку еще раз.",
  archive_too_large: "Файл обновления слишком большой для этой версии приложения.",
  archive_too_many_entries: "Архив обновления выглядит небезопасно. Установка остановлена.",
  archive_unpacked_size_exceeded: "Обновление занимает слишком много места после распаковки.",
  archive_url_has_userinfo: "Адрес архива обновления настроен неверно.",
  archive_url_malformed: "Адрес архива обновления настроен неверно.",
  archive_url_not_https: "Адрес обновления небезопасный. Установка остановлена.",
  archive_url_untrusted_host: "Архив обновления находится не на сервере Brai. Установка остановлена.",
  archive_url_untrusted_path: "Архив обновления находится в неверном разделе сервера.",
  bundle_incompatible: "Для этой web-версии нужно установить новый APK.",
  candidate_missing_entrypoint: "В обновлении нет стартового файла приложения. Нужна новая сборка.",
  candidate_not_ready_before_restart: "Новая web-версия не подтвердила запуск. Оставлена стабильная версия.",
  duplicate_archive_entry: "Архив обновления содержит дубли файлов. Установка остановлена.",
  invalid_bundle_version: "Версия обновления записана неверно.",
  invalid_entrypoint: "Стартовый файл обновления указан неверно.",
  invalid_sha256: "Контрольная сумма обновления указана неверно.",
  invalid_size: "Размер обновления указан неверно.",
  local_archive_missing: "Скачанный файл обновления пропал из памяти телефона. Запусти проверку еще раз.",
  manifest_parse_failed: "Сервер отдал некорректное описание обновления.",
  missing_entrypoint: "В обновлении нет стартового файла приложения. Нужна новая сборка.",
  network_connection_failed: "Не удалось подключиться к серверу обновлений. Проверь интернет и попробуй еще раз.",
  network_connection_lost: "Связь оборвалась во время скачивания. Проверь интернет и попробуй еще раз.",
  network_or_storage_error: "Не удалось скачать или сохранить обновление. Проверь интернет и свободное место.",
  network_timeout: "Сервер обновлений не ответил вовремя. Попробуй еще раз.",
  network_tls_failed: "Не удалось установить защищенное соединение с сервером обновлений.",
  network_unavailable: "Телефон не видит сервер обновлений. Проверь интернет и попробуй еще раз.",
  readiness_timeout: "Новая web-версия не успела запуститься. Оставлена стабильная версия.",
  readiness_version_mismatch: "Запустилась не та web-версия. Оставлена стабильная версия.",
  unsafe_archive_entry: "Архив обновления выглядит небезопасно. Установка остановлена.",
  unsupported_channel: "Телефон не поддерживает канал этого обновления.",
  unsupported_manifest_schema: "Телефон не понимает формат этого обновления. Нужен новый APK.",
  update_failed: "Попробуй проверить его еще раз.",
  unexpected_update_error: "Попробуй проверить его еще раз.",
};

const readyStatuses = new Set(["candidate_ready_for_next_start", "ready_candidate_pending", "candidate_already_pending"]);
const downloadingStatuses = new Set(["checking", "downloading"]);
const ledgerLabels: Record<VersionTypeId, string> = {
  release: "Release",
  build: "Build",
  apk: "APK",
  canon: "Canon",
};
const ledgerOrder: VersionTypeId[] = ["release", "build", "apk", "canon"];

export type UpdateStatusView = {
  label: string;
  body: string;
  tone: Tone;
};

export type EngineSectionView = {
  activeWebVersion: string;
  androidUpdateStage: "idle" | "available" | "downloading" | "ready";
  appBuild: string;
  downloadProgressVersion: string | null;
  downloadProgressPercent: number | null;
  hasUpdate: boolean;
  installedVersion: string;
  isChecking: boolean;
  apkUpdateAvailable: boolean;
  apkReleaseVersion: string | null;
  apkReleaseVersionCode: number | null;
  latestVersion: string;
  ledgerRows: Array<{
    id: VersionTypeId;
    label: string;
    version: string;
    shortChanges: string;
    releasedAtUtc: string;
  }>;
  nativeApk: string | null;
  updateStatus: UpdateStatusView;
};

/**
 * Combines runtime ledger and native OTA state into the Engine page view.
 */
export function engineSectionView({
  appBuild,
  appVersionState,
  otaRefreshing,
  otaState,
  versionError,
  versionRefreshing,
}: {
  appBuild: string;
  appVersionState: AppVersionState | null;
  otaRefreshing: boolean;
  otaState: BraiOtaState | null;
  versionError: boolean;
  versionRefreshing: boolean;
}): EngineSectionView {
  const activeWebVersion = otaState?.activeBundleVersion ?? appBuild;
  const installedVersion = unifiedVersion(activeWebVersion) ?? appBuild;
  const latestVersion = latestKnownVersion(
    installedVersion,
    appVersionState?.version,
    unifiedVersion(otaState?.candidateBundleVersion),
    unifiedVersion(otaState?.downloadProgressVersion),
  );
  const nativeApk = nativeApkLabel(otaState) ?? (appVersionState?.latest.apk ? `${appVersionState.latest.apk.version}` : null);
  const apkRelease = appVersionState?.apk_release ?? null;
  const nativeVersionCode = otaState?.nativeVersionCode;
  const apkUpdateAvailable = Boolean(
    apkRelease && typeof nativeVersionCode === "number" && apkRelease.version_code > nativeVersionCode,
  );
  const isChecking = otaRefreshing || versionRefreshing || Boolean(otaState?.checkInProgress);
  const visibleState =
    !isChecking && otaState?.lastCheckStatus === "checking" ? { ...otaState, lastCheckStatus: "unknown" } : otaState;
  const hasUpdate = apkUpdateAvailable || compareBraiVersions(latestVersion, installedVersion) > 0 || hasReadyOtaUpdate(visibleState);
  const androidUpdateStage = androidStage(visibleState, hasUpdate);
  const updateStatus = engineStatusView({
    apkReleaseVersion: apkRelease?.version ?? null,
    apkReleaseVersionCode: apkRelease?.version_code ?? null,
    apkUpdateAvailable,
    hasUpdate,
    isChecking,
    latestVersion,
    otaState: visibleState,
    versionError,
    versionKnown: Boolean(appVersionState),
  });

  return {
    activeWebVersion,
    androidUpdateStage,
    appBuild,
    apkUpdateAvailable,
    apkReleaseVersion: apkRelease?.version ?? null,
    apkReleaseVersionCode: apkRelease?.version_code ?? null,
    downloadProgressVersion: visibleState?.downloadProgressVersion ?? null,
    downloadProgressPercent: progressPercent(visibleState),
    hasUpdate,
    installedVersion,
    isChecking,
    latestVersion,
    ledgerRows: ledgerRows(appVersionState),
    nativeApk,
    updateStatus,
  };
}

/**
 * Compares Brai X.Y.Z.S versions and ignores non-production suffixes.
 */
export function compareBraiVersions(left: string, right: string): number {
  const leftParts = braiVersionParts(left);
  const rightParts = braiVersionParts(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * Formats the native APK identity from the Android OTA bridge state.
 */
export function nativeApkLabel(state: BraiOtaState | null): string | null {
  if (state?.nativeVersionName) {
    const version = isUnifiedVersion(state.nativeVersionName) || !state.nativeBuild ? state.nativeVersionName : `${state.nativeVersionName}+${state.nativeBuild}`;
    return state.nativeVersionCode ? `${version} (${state.nativeVersionCode})` : version;
  }
  const fallbackUnified = unifiedVersion(state?.fallbackBundleVersion);
  if (fallbackUnified) return fallbackUnified;
  const match = state?.fallbackBundleVersion?.match(/^([0-9.]+)\+([0-9]+)\.web\./);
  return match ? `${match[1]}+${match[2]}` : null;
}

/**
 * Converts native OTA error codes and legacy raw messages into user-facing text.
 */
export function humanUpdateError(raw: string | null | undefined): string {
  const value = raw?.trim();
  if (!value) return "Попробуй проверить обновление еще раз.";
  const http = value.match(/^(manifest_http|archive_download_http)_(\d+)$/);
  if (http) {
    return http[1] === "manifest_http"
      ? `Сервер не отдал описание обновления (HTTP ${http[2]}).`
      : `Сервер не отдал файл обновления (HTTP ${http[2]}).`;
  }
  if (value.startsWith("manifest_missing_") || value.startsWith("manifest_invalid_")) {
    return "Описание обновления на сервере заполнено неверно.";
  }
  const known = updateErrorMessages[value];
  if (known) return known;

  const lower = value.toLowerCase();
  if (lower.includes("software caused connection abort") || lower.includes("connection reset") || lower.includes("broken pipe")) {
    return updateErrorMessages.network_connection_lost;
  }
  if (lower.includes("enoent") || lower.includes("no such file")) {
    return updateErrorMessages.local_archive_missing;
  }
  if (lower.includes("timeout")) {
    return updateErrorMessages.network_timeout;
  }
  return updateErrorMessages.unexpected_update_error;
}

function engineStatusView({
  apkReleaseVersion,
  apkReleaseVersionCode,
  apkUpdateAvailable,
  hasUpdate,
  isChecking,
  latestVersion,
  otaState,
  versionError,
  versionKnown,
}: {
  apkReleaseVersion: string | null;
  apkReleaseVersionCode: number | null;
  apkUpdateAvailable: boolean;
  hasUpdate: boolean;
  isChecking: boolean;
  latestVersion: string;
  otaState: BraiOtaState | null;
  versionError: boolean;
  versionKnown: boolean;
}): UpdateStatusView {
  if (isChecking) return { label: "проверка", body: "Проверяем версии Brai.", tone: "muted" };

  switch (otaState?.lastCheckStatus) {
    case "candidate_ready_for_next_start":
    case "ready_candidate_pending":
    case "candidate_already_pending":
      return { label: "готово", body: "Закройте приложение, чтобы новая версия применилась.", tone: "warn" };
    case "downloading":
      return { label: "загрузка", body: `Загружается версия ${latestVersion}.`, tone: "warn" };
    case "candidate_loading":
      return { label: "загрузка", body: "Запускается новая web-версия.", tone: "warn" };
    case "candidate_failed":
    case "check_failed":
      return { label: "ошибка", body: `Обновление не установилось. ${humanUpdateError(otaState.lastUpdateError)}`, tone: "bad" };
    case "skipped_failed_bundle":
      return {
        label: "пропущено",
        body: "Эта web-версия уже не запустилась на телефоне. Дождись следующей версии или установи новый APK.",
        tone: "bad",
      };
    case "incompatible":
      return { label: "нужен APK", body: "Для этой web-версии нужно установить новый APK.", tone: "bad" };
    default:
      break;
  }

  if (apkUpdateAvailable) {
    const code = apkReleaseVersionCode ? `, versionCode ${apkReleaseVersionCode}` : "";
    return { label: "нужен APK", body: `Доступен новый APK v${apkReleaseVersion ?? latestVersion}${code}.`, tone: "warn" };
  }
  if (hasUpdate) return { label: "доступно", body: `Доступна версия ${latestVersion}.`, tone: "warn" };
  if (versionError && !versionKnown) return { label: "нет связи", body: "Не удалось проверить последнюю версию.", tone: "muted" };
  return { label: "актуально", body: "Установлена текущая версия Brai.", tone: "ok" };
}

function hasReadyOtaUpdate(state: BraiOtaState | null): boolean {
  return Boolean(state?.lastCheckStatus && readyStatuses.has(state.lastCheckStatus) && state.candidateBundleVersion);
}

function androidStage(state: BraiOtaState | null, hasUpdate: boolean): EngineSectionView["androidUpdateStage"] {
  if (!state) return "idle";
  if (state.lastCheckStatus && readyStatuses.has(state.lastCheckStatus)) return "ready";
  if (state.checkInProgress || (state.lastCheckStatus && downloadingStatuses.has(state.lastCheckStatus))) return "downloading";
  return hasUpdate ? "available" : "idle";
}

function progressPercent(state: BraiOtaState | null): number | null {
  const explicit = state?.downloadProgressPercent;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return clampProgress(explicit);
  const bytes = state?.downloadProgressBytes;
  const total = state?.downloadProgressTotalBytes;
  if (typeof bytes !== "number" || typeof total !== "number" || total <= 0) return null;
  return clampProgress((bytes / total) * 100);
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function latestKnownVersion(installedVersion: string, ...versions: Array<string | null | undefined>): string {
  return versions.reduce<string>((latest, version) => {
    if (!version) return latest;
    return compareBraiVersions(version, latest) > 0 ? version : latest;
  }, installedVersion);
}

function ledgerRows(state: AppVersionState | null): EngineSectionView["ledgerRows"] {
  if (!state) return [];
  return ledgerOrder.flatMap((id) => {
    const row = state.latest[id];
    return row
      ? [{
          id,
          label: ledgerLabels[id],
          version: `${row.version}`,
          shortChanges: row.short_changes,
          releasedAtUtc: row.released_at_utc,
        }]
      : [];
  });
}

function braiVersionParts(value: string | null | undefined): [number, number, number, number] | null {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function isUnifiedVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value);
}

function unifiedVersion(value: string | null | undefined): string | null {
  const match = value?.match(/^(\d+\.\d+\.\d+\.\d+)(?:$|[.+-])/);
  return match?.[1] ?? null;
}
