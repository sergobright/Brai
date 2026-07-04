import type { AppVersionState } from "@/shared/api/braiApi";
import type { BraiOtaState } from "@/shared/platform/ota";
import type { Tone } from "../../appModel";

const updateErrorMessages: Record<string, string> = {
  apk_required: "Для этой OTA-версии нужно установить новый APK.",
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
  bundle_incompatible: "Для этой OTA-версии нужно установить новый APK.",
  candidate_missing_entrypoint: "В обновлении нет стартового файла приложения. Нужна новая сборка.",
  candidate_not_ready_before_restart: "Новая OTA-версия не подтвердила запуск. Оставлена стабильная версия.",
  duplicate_archive_entry: "Архив обновления содержит дубли файлов. Установка остановлена.",
  invalid_bundle_version: "Версия обновления записана неверно.",
  invalid_native_apk_version: "Версия установленного APK записана неверно. Нужен новый APK.",
  invalid_ota_version: "OTA-версия записана неверно.",
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
  readiness_timeout: "Новая OTA-версия не успела запуститься. Оставлена стабильная версия.",
  readiness_version_mismatch: "Запустилась не та OTA-версия. Оставлена стабильная версия.",
  unsafe_archive_entry: "Архив обновления выглядит небезопасно. Установка остановлена.",
  unsupported_channel: "Телефон не поддерживает канал этого обновления.",
  unsupported_manifest_schema: "Телефон не понимает формат этого обновления. Нужен новый APK.",
  update_failed: "Попробуй проверить его еще раз.",
  unexpected_update_error: "Попробуй проверить его еще раз.",
};

const readyStatuses = new Set(["candidate_ready_for_next_start", "ready_candidate_pending", "candidate_already_pending"]);
const downloadingStatuses = new Set(["checking", "downloading"]);
const apkRequiredStatuses = new Set(["apk_required", "incompatible"]);

type ApkBuildKind = "stable" | "preview";

type ApkIdentity = {
  version: number | null;
  releaseKey: string | null;
  buildKind: ApkBuildKind;
  previewIteration: number;
};

type ApkTarget = ApkIdentity & {
  label: string | null;
  releaseUrl: string;
};

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
  requiredApkVersion: number | null;
  requiredApkLabel: string | null;
  apkReleaseUrl: string;
  latestVersion: string;
  updateStatus: UpdateStatusView;
};

/**
 * Combines API and native OTA state into the Engine page view.
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
  const activeWebVersion = otaVersion(otaState?.activeBundleVersion) ?? otaVersion(appBuild) ?? "0.0.0";
  const installedVersion = activeWebVersion;
  const latestVersion = latestKnownVersion(
    installedVersion,
    appVersionState?.ota_version ?? appVersionState?.version,
    otaState?.candidateBundleVersion,
    otaState?.downloadProgressVersion,
  );
  const nativeApk = nativeApkIdentity(otaState);
  const targetApk = targetApkIdentity(otaState, appVersionState);
  const requiredApkVersion = targetApk.version;
  const apkUpdateAvailable = Boolean(
    (targetApk.version && nativeApk.version && !isApkCompatible(nativeApk, targetApk)) ||
      (otaState?.lastCheckStatus && apkRequiredStatuses.has(otaState.lastCheckStatus)),
  );
  const isChecking = otaRefreshing || versionRefreshing || Boolean(otaState?.checkInProgress);
  const visibleState =
    !isChecking && otaState?.lastCheckStatus === "checking" ? { ...otaState, lastCheckStatus: "unknown" } : otaState;
  const hasUpdate = apkUpdateAvailable || compareBraiVersions(latestVersion, installedVersion) > 0 || hasReadyOtaUpdate(visibleState);
  const androidUpdateStage = androidStage(visibleState, hasUpdate);
  const apkReleaseUrl = targetApk.releaseUrl;
  const updateStatus = engineStatusView({
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
    requiredApkVersion,
    requiredApkLabel: targetApk.label,
    apkReleaseUrl,
    downloadProgressVersion: otaVersion(visibleState?.downloadProgressVersion),
    downloadProgressPercent: progressPercent(visibleState),
    hasUpdate,
    installedVersion,
    isChecking,
    latestVersion,
    updateStatus,
  };
}

function nativeApkIdentity(state: BraiOtaState | null): ApkIdentity {
  return {
    version: apkVersion(state?.nativeApkVersion ?? state?.nativeVersionName),
    releaseKey: textValue(state?.nativeApkReleaseKey),
    buildKind: apkBuildKind(state?.nativeApkBuildKind),
    previewIteration: iterationValue(state?.nativeApkPreviewIteration) ?? 0,
  };
}

function targetApkIdentity(state: BraiOtaState | null, appVersionState: AppVersionState | null): ApkTarget {
  const apiTarget = appVersionState?.target_apk ?? appVersionState?.apk_release ?? null;
  const buildKind = apkBuildKind(state?.targetApkBuildKind ?? apiTarget?.apk_build_kind);
  const previewIteration = iterationValue(state?.targetApkPreviewIteration) ?? iterationValue(apiTarget?.preview_iteration) ?? 0;
  const version = apkVersion(state?.targetApkVersion) ?? apkVersion(apiTarget?.version);
  return {
    version,
    releaseKey: textValue(state?.targetApkReleaseKey) ?? textValue(apiTarget?.release_key),
    buildKind,
    previewIteration,
    label: formatApkTargetLabel(version, buildKind, previewIteration),
    releaseUrl: state?.targetApkReleaseUrl || apiTarget?.release_url || "/releases/",
  };
}

function isApkCompatible(native: ApkIdentity, target: ApkIdentity): boolean {
  if (!native.version || !target.version) return true;
  if (target.releaseKey && !native.releaseKey && target.buildKind === "stable" && native.buildKind === "stable") {
    return native.version >= target.version;
  }
  if (target.releaseKey && target.releaseKey !== native.releaseKey) return false;
  if (target.buildKind === "preview") {
    return native.buildKind === "preview" && native.version === target.version && native.previewIteration >= target.previewIteration;
  }
  if (native.buildKind !== "stable") return false;
  return native.version >= target.version;
}

export function formatApkTargetLabel(version: number | string | null | undefined, buildKind?: string | null, previewIteration?: number | string | null): string | null {
  const apk = apkVersion(version);
  if (!apk) return null;
  const iteration = iterationValue(previewIteration);
  return apkBuildKind(buildKind) === "preview" && iteration ? `v${apk}-preview${iteration}` : `v${apk}`;
}

/**
 * Compares Brai OTA X.Y.Z versions.
 */
export function compareBraiVersions(left: string, right: string): number {
  const leftParts = otaVersionParts(left);
  const rightParts = otaVersionParts(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * Converts native OTA error codes into user-facing Russian copy.
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
  apkUpdateAvailable,
  hasUpdate,
  isChecking,
  latestVersion,
  otaState,
  versionError,
  versionKnown,
}: {
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
      return { label: "готово", body: `OTA-версия ${latestVersion} загружена.`, tone: "warn" };
    case "downloading":
      return { label: "загрузка", body: `Загружается OTA-версия ${latestVersion}.`, tone: "warn" };
    case "candidate_loading":
      return { label: "загрузка", body: "Запускается новая OTA-версия.", tone: "warn" };
    case "candidate_failed":
    case "check_failed":
      return { label: "ошибка", body: `Обновление не установилось. ${humanUpdateError(otaState.lastUpdateError)}`, tone: "bad" };
    case "skipped_failed_bundle":
      return {
        label: "пропущено",
        body: "Эта OTA-версия уже не запустилась на телефоне. Дождись следующей версии или установи новый APK.",
        tone: "bad",
      };
    case "apk_required":
    case "incompatible":
      return { label: "нужен APK", body: "Нужен новый APK для этой OTA-версии.", tone: "bad" };
    default:
      break;
  }

  if (apkUpdateAvailable) return { label: "нужен APK", body: "Нужен новый APK для этой OTA-версии.", tone: "warn" };
  if (hasUpdate) return { label: "доступно", body: `Доступна OTA-версия ${latestVersion}.`, tone: "warn" };
  if (versionError && !versionKnown) return { label: "нет связи", body: "Не удалось проверить последнюю версию.", tone: "muted" };
  return { label: "актуально", body: "Установлена текущая OTA-версия Brai.", tone: "ok" };
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
    const normalized = otaVersion(version);
    if (!normalized) return latest;
    return compareBraiVersions(normalized, latest) > 0 ? normalized : latest;
  }, installedVersion);
}

function otaVersionParts(value: string | null | undefined): [number, number, number] | null {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function otaVersion(value: string | null | undefined): string | null {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[.+_-])/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function apkVersion(value: string | number | null | undefined): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function iterationValue(value: string | number | null | undefined): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function apkBuildKind(value: string | null | undefined): ApkBuildKind {
  return value === "preview" ? "preview" : "stable";
}

function textValue(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
