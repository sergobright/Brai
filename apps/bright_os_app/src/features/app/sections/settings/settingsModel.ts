import type { BrightOtaState } from "@/shared/platform/ota";
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
  archive_url_untrusted_host: "Архив обновления находится не на сервере Bright OS. Установка остановлена.",
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

export type UpdateStatusView = {
  label: string;
  body: string;
  tone: Tone;
};

export type SettingsSectionView = {
  activeWebVersion: string;
  appBuild: string;
  isChecking: boolean;
  nativeApk: string;
  updateStatus: UpdateStatusView;
};

export function settingsSectionView({
  appBuild,
  otaRefreshing,
  otaState,
}: {
  appBuild: string;
  otaRefreshing: boolean;
  otaState: BrightOtaState | null;
}): SettingsSectionView {
  const nativeApk = nativeApkLabel(otaState) ?? appBuild;
  const activeWebVersion = otaState?.activeBundleVersion ?? `из APK (${appBuild})`;
  const isChecking = otaRefreshing || Boolean(otaState?.checkInProgress);
  const visibleState =
    !isChecking && otaState?.lastCheckStatus === "checking" ? { ...otaState, lastCheckStatus: "unknown" } : otaState;
  const updateStatus = updateStatusView(
    isChecking ? { activeBundleVersion: activeWebVersion, lastCheckStatus: "checking" } : visibleState,
  );
  return { activeWebVersion, appBuild, isChecking, nativeApk, updateStatus };
}

export function nativeApkLabel(state: BrightOtaState | null): string | null {
  if (state?.nativeVersionName) {
    const version = isUnifiedVersion(state.nativeVersionName) || !state.nativeBuild ? state.nativeVersionName : `${state.nativeVersionName}+${state.nativeBuild}`;
    return state.nativeVersionCode ? `${version} (${state.nativeVersionCode})` : version;
  }
  const unifiedMatch = state?.fallbackBundleVersion?.match(/^(\d+\.\d+\.\d+\.\d+)(?:$|[.+-])/);
  if (unifiedMatch) return unifiedMatch[1];
  const match = state?.fallbackBundleVersion?.match(/^([0-9.]+)\+([0-9]+)\.web\./);
  return match ? `${match[1]}+${match[2]}` : null;
}

function isUnifiedVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value);
}

/**
 * Maps native OTA state into the compact Settings update status copy.
 */
export function updateStatusView(state: BrightOtaState | null): UpdateStatusView {
  if (!state) {
    return {
      label: "web",
      body: "В браузере обновление появится после перезагрузки страницы.",
      tone: "muted",
    };
  }

  switch (state.lastCheckStatus) {
    case "checking":
      return { label: "проверка", body: "Проверяем, есть ли новая web-версия.", tone: "muted" };
    case "candidate_ready_for_next_start":
    case "ready_candidate_pending":
    case "candidate_already_pending":
      return { label: "готово", body: "Обновление скачано. Закрой и открой приложение.", tone: "warn" };
    case "candidate_loading":
      return { label: "загрузка", body: "Запускается новая web-версия.", tone: "warn" };
    case "candidate_failed":
    case "check_failed":
      return { label: "ошибка", body: `Обновление не установилось. ${humanUpdateError(state.lastUpdateError)}`, tone: "bad" };
    case "skipped_failed_bundle":
      return {
        label: "пропущено",
        body: "Эта web-версия уже не запустилась на телефоне. Дождись следующей версии или установи новый APK.",
        tone: "bad",
      };
    case "incompatible":
      return { label: "нужен APK", body: "Для этой web-версии нужно установить новый APK.", tone: "bad" };
    case "startup_fallback":
      return { label: "из APK", body: "Работает web-версия, встроенная в APK.", tone: "muted" };
    default:
      return { label: "активно", body: "Установлена текущая web-версия.", tone: "ok" };
  }
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
