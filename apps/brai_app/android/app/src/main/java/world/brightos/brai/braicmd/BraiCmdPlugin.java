package world.brightos.brai.braicmd;

import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

import world.brightos.brai.BuildConfig;
import world.brightos.brai.capabilities.BraiAccessibilityService;

@CapacitorPlugin(
    name = "BraiCmd",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public final class BraiCmdPlugin extends Plugin {
    private static final String EVENT_ONBOARDING = "onboardingEvent";
    private static final String EVENT_CREDENTIAL_REFRESH = "credentialRefreshRequired";
    private static final String EVENT_STATE_CHANGED = "stateChanged";
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static final CredentialOperationSequencer CREDENTIAL_OPERATIONS =
        CredentialOperationSequencer.createDefault();
    private static volatile BraiCmdPlugin activePlugin;

    @Override
    public void load() {
        activePlugin = this;
        ConfigStore config = new ConfigStore(getContext());
        config.setOnboardingQueuePaused(!config.getAccountUserId().isBlank());
        CREDENTIAL_OPERATIONS.enqueueMaintenance(() ->
            BraiCmdBridge.INSTANCE.retryPendingAccountRevocation(getContext())
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (activePlugin == this) activePlugin = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(stateJson());
    }

    @PluginMethod
    public void vibratePress(PluginCall call) {
        Haptics.INSTANCE.buttonPress(getContext());
        call.resolve(stateJson());
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        call.resolve(BraiCmdBridge.INSTANCE.snapshot(getContext()));
    }

    @PluginMethod
    public void getSettings(PluginCall call) {
        call.resolve(BraiCmdBridge.INSTANCE.snapshot(getContext()));
    }

    @PluginMethod
    public void updateSettings(PluginCall call) {
        JSObject patch = call.getObject("patch", new JSObject());
        BraiCmdBridge.INSTANCE.updateSettings(getContext(), patch == null ? new JSObject() : patch);
        JSObject snapshot = BraiCmdBridge.INSTANCE.snapshot(getContext());
        notifyStateChangedNow(snapshot);
        call.resolve(snapshot);
    }

    @PluginMethod
    public void saveProvider(PluginCall call) {
        JSObject input = call.getObject("provider", new JSObject());
        BraiCmdBridge.INSTANCE.saveProvider(getContext(), input == null ? new JSObject() : input);
        RecordingService.Companion.retryPending(getContext());
        JSObject snapshot = BraiCmdBridge.INSTANCE.snapshot(getContext());
        notifyStateChangedNow(snapshot);
        call.resolve(snapshot);
    }

    @PluginMethod
    public void testConnection(PluginCall call) {
        new Thread(() -> {
            JSObject result = new JSObject();
            try {
                ConfigStore config = new ConfigStore(getContext());
                org.json.JSONObject diagnostics = new NetworkClient(getContext()).diagnostics("cloud".equals(config.getTranscriptionProviderMode()));
                result = new JSObject(diagnostics.toString());
                result.put("message", "Подключение к Brai работает");
            } catch (Throwable error) {
                result.put("ok", false);
                result.put("message", providerMessage(error, "Не удалось подключиться к серверам Brai"));
            }
            JSObject finalResult = result;
            MAIN_HANDLER.post(() -> call.resolve(finalResult));
        }).start();
    }

    @PluginMethod
    public void testProvider(PluginCall call) {
        JSObject input = call.getObject("provider", new JSObject());
        JSObject provider = input == null ? new JSObject() : input;
        new Thread(() -> {
            try {
                JSObject result = new LlmProviderClient(getContext()).test(
                    provider.optString("providerId", ""),
                    provider.optString("apiKey", ""),
                    provider.optString("model", ""),
                    provider.optString("baseUrl", "")
                );
                MAIN_HANDLER.post(() -> call.resolve(result));
            } catch (Throwable error) {
                JSObject result = new JSObject();
                result.put("ok", false);
                result.put("message", error.getMessage() == null || error.getMessage().isBlank() ? "Не удалось подключить поставщика" : error.getMessage());
                MAIN_HANDLER.post(() -> call.resolve(result));
            }
        }).start();
    }

    @PluginMethod
    public void probeProvider(PluginCall call) {
        JSObject input = call.getObject("provider", new JSObject());
        JSObject provider = input == null ? new JSObject() : input;
        new Thread(() -> {
            JSObject result;
            try {
                result = new LlmProviderClient(getContext()).probe(
                    provider.optString("providerId", ""),
                    provider.optString("apiKey", ""),
                    provider.optString("baseUrl", ""),
                    provider.optString("capability", "text")
                );
            } catch (Throwable error) {
                result = new JSObject();
                result.put("ok", false);
                result.put("message", providerMessage(error, "Не удалось проверить поставщика"));
            }
            JSObject finalResult = result;
            MAIN_HANDLER.post(() -> call.resolve(finalResult));
        }).start();
    }

    @PluginMethod
    public void connectProvider(PluginCall call) {
        JSObject input = call.getObject("provider", new JSObject());
        JSObject provider = input == null ? new JSObject() : input;
        new Thread(() -> {
            JSObject result;
            try {
                result = new LlmProviderClient(getContext()).connect(
                    provider.optString("providerId", ""),
                    provider.optString("apiKey", ""),
                    provider.optString("model", ""),
                    provider.optString("baseUrl", ""),
                    provider.optString("capability", "text")
                );
                BraiCmdBridge.INSTANCE.saveProvider(getContext(), provider);
                result.put("state", BraiCmdBridge.INSTANCE.snapshot(getContext()));
                RecordingService.Companion.retryPending(getContext());
            } catch (Throwable error) {
                result = new JSObject();
                result.put("ok", false);
                result.put("message", providerMessage(error, "Не удалось подключить поставщика"));
            }
            JSObject finalResult = result;
            MAIN_HANDLER.post(() -> {
                if (finalResult.optBoolean("ok")) notifyStateChanged();
                call.resolve(finalResult);
            });
        }).start();
    }

    @PluginMethod
    public void disconnectProvider(PluginCall call) {
        String providerId = call.getString("providerId", "");
        JSObject snapshot = BraiCmdBridge.INSTANCE.disconnectProvider(getContext(), providerId == null ? "" : providerId);
        notifyStateChangedNow(snapshot);
        call.resolve(snapshot);
    }

    @PluginMethod
    public void deleteAudio(PluginCall call) {
        String id = call.getString("id", "");
        JSObject result = new JSObject();
        result.put("ok", RecordingArchiveStore.INSTANCE.delete(getContext(), id == null ? "" : id));
        result.put("state", BraiCmdBridge.INSTANCE.snapshot(getContext()));
        notifyStateChanged();
        call.resolve(result);
    }

    @PluginMethod
    public void downloadAudio(PluginCall call) {
        String id = call.getString("id", "");
        new Thread(() -> {
            JSObject result = new JSObject();
            try {
                String path = RecordingArchiveStore.INSTANCE.download(getContext(), id == null ? "" : id);
                result.put("ok", true);
                result.put("path", path);
            } catch (Throwable error) {
                result.put("ok", false);
                result.put("message", "Не удалось сохранить аудиозапись");
            }
            MAIN_HANDLER.post(() -> call.resolve(result));
        }).start();
    }

    @PluginMethod
    public void openPermission(PluginCall call) {
        String permission = call.getString("permission", "");
        if ("accessibility".equals(permission)) {
            startSettingsActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        } else if ("overlay".equals(permission)) {
            openOverlaySettings(call);
            return;
        } else if ("microphone".equals(permission)) {
            requestMicrophone(call);
            return;
        } else if ("notifications".equals(permission)) {
            requestNotifications(call);
            return;
        }
        call.resolve(BraiCmdBridge.INSTANCE.snapshot(getContext()));
    }

    @PluginMethod
    public void setVoiceOnlyMode(PluginCall call) {
        ConfigStore config = new ConfigStore(getContext());
        boolean enabled = call.getBoolean("enabled", false);
        config.setOnboardingVoiceOnly(enabled);
        if (!enabled) config.setOnboardingQueuePaused(false);
        call.resolve(stateJson());
    }

    @PluginMethod
    public void setOverlayEnabled(PluginCall call) {
        ConfigStore config = new ConfigStore(getContext());
        config.setOverlayEnabled(call.getBoolean("enabled", false));
        call.resolve(stateJson());
    }

    @PluginMethod
    public void setAuthenticatedMode(PluginCall call) {
        String requestedUserId = call.getString("userId", "");
        String cleanUserId = requestedUserId == null ? "" : requestedUserId.trim();
        boolean enabled = call.getBoolean("enabled", false);
        CREDENTIAL_OPERATIONS.enqueueMaintenance(() -> {
            try {
                BraiCmdBridge.INSTANCE.setAuthenticatedMode(getContext(), cleanUserId, enabled);
                JSObject state = stateJson();
                MAIN_HANDLER.post(() -> {
                    notifyStateChangedNow(BraiCmdBridge.INSTANCE.snapshot(getContext()));
                    call.resolve(state);
                });
            } catch (Throwable error) {
                rejectAccountAccess(call, error);
            }
        });
    }

    @PluginMethod
    public void ensureAccess(PluginCall call) {
        String displayName = cleanDisplayName(call.getString("displayName", ""));
        String expectedUserId = new ConfigStore(getContext()).getAccountUserId();
        CREDENTIAL_OPERATIONS.enqueue(generation -> {
            ConfigStore config = new ConfigStore(getContext());
            try {
                checkCurrentCredentialOperation(generation);
                if (!displayName.isBlank()) config.setDisplayName(displayName);
                String requestedName = config.getDisplayName().isBlank() ? "Brai" : config.getDisplayName();
                new NetworkClient(getContext()).ensureDeviceAccess(
                    requestedName,
                    deviceFingerprint(),
                    () -> CREDENTIAL_OPERATIONS.isCurrent(generation) &&
                        expectedUserId.equals(new ConfigStore(getContext()).getAccountUserId())
                );
            } catch (Throwable error) {
                if (CREDENTIAL_OPERATIONS.isCurrent(generation) &&
                    expectedUserId.equals(config.getAccountUserId())) {
                    config.setAuthToken("");
                }
            }
            JSObject state = stateJson();
            MAIN_HANDLER.post(() -> call.resolve(state));
        });
    }

    @PluginMethod
    public void preparePreliminaryProfile(PluginCall call) {
        ConfigStore config = new ConfigStore(getContext());
        String displayName = cleanDisplayName(call.getString("displayName", ""));
        if (displayName.isBlank()) {
            call.reject("Введите имя");
            return;
        }
        String fingerprint = deviceFingerprint();
        if (fingerprint.isBlank()) {
            call.reject("Не удалось определить устройство");
            return;
        }
        new Thread(() -> {
            try {
                NetworkClient client = new NetworkClient(getContext());
                PreliminaryProfileResponse profile = client.requestPreliminaryProfile(displayName, fingerprint);
                if (profile.getDuplicateDevice()) {
                    config.setPreliminaryUserId(profile.getPreliminaryUserId());
                    config.setPreliminaryClaimToken("");
                    call.resolve(preliminaryStateJson(profile, fingerprint));
                    return;
                }
                config.setDisplayName(profile.getDisplayName().isBlank() ? displayName : profile.getDisplayName());
                config.setPreliminaryUserId(profile.getPreliminaryUserId());
                config.setPreliminaryClaimToken(profile.getPreliminaryClaimToken());
                call.resolve(preliminaryStateJson(profile, fingerprint));
            } catch (Throwable error) {
                Exception exception = error instanceof Exception ? (Exception) error : new Exception(error);
                call.reject("Не удалось проверить устройство", NetworkClientKt.preliminaryFailureCode(error), exception);
            }
        }).start();
    }

    @PluginMethod
    public void beginAccountCredentialMode(PluginCall call) {
        String requestedUserId = call.getString("userId", "");
        String cleanUserId = requestedUserId == null ? "" : requestedUserId.trim();
        CREDENTIAL_OPERATIONS.enqueue(generation -> {
            try {
                if (!CREDENTIAL_OPERATIONS.isCurrent(generation)) {
                    throw new IllegalStateException("credential_operation_superseded");
                }
                BraiCmdBridge.INSTANCE.beginAccountCredentialMode(getContext(), cleanUserId);
                JSObject state = stateJson();
                MAIN_HANDLER.post(() -> {
                    notifyStateChangedNow(BraiCmdBridge.INSTANCE.snapshot(getContext()));
                    call.resolve(state);
                });
            } catch (Throwable error) {
                rejectAccountAccess(call, error);
            }
        });
    }

    @PluginMethod
    public void setAccessKey(PluginCall call) {
        String token = call.getString("token", "");
        String displayName = cleanDisplayName(call.getString("displayName", ""));
        String requestedUserId = call.getString("userId", "");
        String cleanToken = token == null ? "" : token.trim();
        String cleanUserId = requestedUserId == null ? "" : requestedUserId.trim();
        CREDENTIAL_OPERATIONS.enqueue(generation -> {
            try {
                if (cleanToken.isBlank()) {
                    BraiCmdBridge.INSTANCE.endAccountCredentialMode(getContext());
                } else if (cleanUserId.isBlank()) {
                    checkCurrentCredentialOperation(generation);
                    BraiCmdBridge.INSTANCE.updateAccess(getContext(), cleanToken, displayName, "");
                } else {
                    checkCurrentCredentialOperation(generation);
                    AccountAccessResponse response = new NetworkClient(getContext()).activateAccountAccess(cleanToken);
                    checkCurrentCredentialOperation(generation);
                    BraiCmdBridge.INSTANCE.applyActivatedAccountAccess(
                        getContext(),
                        cleanUserId,
                        displayName,
                        response
                    );
                }
                JSObject state = stateJson();
                MAIN_HANDLER.post(() -> {
                    notifyStateChangedNow(BraiCmdBridge.INSTANCE.snapshot(getContext()));
                    call.resolve(state);
                });
                if (cleanToken.isBlank()) {
                    BraiCmdBridge.INSTANCE.retryPendingAccountRevocation(getContext());
                }
            } catch (Throwable error) {
                rejectAccountAccess(call, error);
            }
        });
    }

    @PluginMethod
    public void syncProviderCredentials(PluginCall call) {
        String expectedUserId = new ConfigStore(getContext()).getAccountUserId();
        CREDENTIAL_OPERATIONS.enqueue(generation -> {
            JSObject result;
            try {
                checkCurrentCredentialOperation(generation);
                result = BraiCmdBridge.INSTANCE.syncProviderCredentials(
                    getContext(),
                    expectedUserId,
                    () -> CREDENTIAL_OPERATIONS.isCurrent(generation)
                );
            } catch (Throwable error) {
                BraiCmdBridge.INSTANCE.invalidateAccountProviderCredentials(getContext());
                result = new JSObject();
                result.put("ok", false);
                result.put("code", providerCredentialSyncCode(error));
                result.put("message", providerCredentialSyncMessage(error));
            }
            JSObject finalResult = result;
            MAIN_HANDLER.post(() -> {
                if (finalResult.optBoolean("ok")) notifyStateChanged();
                call.resolve(finalResult);
            });
        });
    }

    @PluginMethod
    public void invalidateProviderCredentials(PluginCall call) {
        CREDENTIAL_OPERATIONS.enqueue(generation -> {
            try {
                checkCurrentCredentialOperation(generation);
                BraiCmdBridge.INSTANCE.invalidateAccountProviderCredentials(getContext());
                JSObject result = new JSObject();
                result.put("ok", true);
                MAIN_HANDLER.post(() -> {
                    notifyStateChanged();
                    call.resolve(result);
                });
            } catch (Throwable error) {
                JSObject result = new JSObject();
                result.put("ok", false);
                MAIN_HANDLER.post(() -> call.resolve(result));
            }
        });
    }

    @PluginMethod
    public void retryPendingAccountRevocation(PluginCall call) {
        CREDENTIAL_OPERATIONS.enqueueMaintenance(() -> {
            boolean ok = BraiCmdBridge.INSTANCE.retryPendingAccountRevocation(getContext());
            JSObject result = new JSObject();
            result.put("ok", ok);
            MAIN_HANDLER.post(() -> call.resolve(result));
        });
    }

    @PluginMethod
    public void setQueuePausedMode(PluginCall call) {
        ConfigStore config = new ConfigStore(getContext());
        config.setOnboardingQueuePaused(call.getBoolean("enabled", false));
        call.resolve(stateJson());
    }

    @PluginMethod
    public void retryQueue(PluginCall call) {
        RecordingService.Companion.retryPending(getContext());
        call.resolve(stateJson());
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        startSettingsActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        call.resolve(stateJson());
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            startSettingsActivity(new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())
            ));
        }
        call.resolve(stateJson());
    }

    @PluginMethod
    public void requestMicrophone(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(stateJson());
            return;
        }
        requestPermissionForAlias("microphone", call, "permissionResult");
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(stateJson());
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionResult");
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        call.resolve(stateJson());
    }

    private JSObject stateJson() {
        ConfigStore config = new ConfigStore(getContext());
        JSObject state = new JSObject();
        state.put("native", true);
        state.put("accountCredentialsActive", !config.getAccountUserId().isBlank());
        state.put("accessGranted", !config.getAuthToken().isBlank());
        state.put("deviceId", config.getInstallId());
        state.put("clientVersion", BuildConfig.VERSION_NAME);
        state.put("appPackage", getContext().getPackageName());
        state.put("voiceOnlyMode", config.getOnboardingVoiceOnly());
        state.put("queuePausedMode", config.getOnboardingQueuePaused());
        state.put("overlayEnabled", config.getOverlayEnabled());
        state.put("settingsDeclared", hasActivity(BraiCmdSettingsActivity.class));
        state.put("accessibilityServiceDeclared", hasService(BraiAccessibilityService.class));
        state.put("recordingServiceDeclared", hasService(RecordingService.class));
        state.put("accessibilityServiceEnabled", isAccessibilityServiceEnabled());
        state.put("overlayDeclared", hasRequestedPermission(Manifest.permission.SYSTEM_ALERT_WINDOW));
        state.put("overlayGranted", canDrawOverlays());
        state.put("microphoneDeclared", hasRequestedPermission(Manifest.permission.RECORD_AUDIO));
        state.put("microphoneGranted", getPermissionState("microphone") == PermissionState.GRANTED);
        state.put("notificationsDeclared", hasRequestedPermission(Manifest.permission.POST_NOTIFICATIONS));
        state.put("notificationsGranted", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED);
        state.put("dataSyncForegroundServiceDeclared", hasRequestedPermission(Manifest.permission.FOREGROUND_SERVICE_DATA_SYNC));
        state.put("microphoneForegroundServiceDeclared", hasRequestedPermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE));
        state.put("networkStateDeclared", hasRequestedPermission(Manifest.permission.ACCESS_NETWORK_STATE));
        state.put("vibrateDeclared", hasRequestedPermission(Manifest.permission.VIBRATE));
        return state;
    }

    private boolean canDrawOverlays() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(getContext());
    }

    private boolean hasRequestedPermission(String permission) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(
                getContext().getPackageName(),
                PackageManager.GET_PERMISSIONS
            );
            if (info.requestedPermissions == null) return false;
            for (String requested : info.requestedPermissions) {
                if (permission.equals(requested)) return true;
            }
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
        return false;
    }

    private boolean hasService(Class<?> serviceClass) {
        try {
            getContext().getPackageManager().getServiceInfo(
                new ComponentName(getContext(), serviceClass),
                PackageManager.GET_META_DATA
            );
            return true;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    private boolean hasActivity(Class<?> activityClass) {
        try {
            getContext().getPackageManager().getActivityInfo(
                new ComponentName(getContext(), activityClass),
                PackageManager.GET_META_DATA
            );
            return true;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    private boolean isAccessibilityServiceEnabled() {
        AccessibilityManager manager = (AccessibilityManager) getContext().getSystemService(android.content.Context.ACCESSIBILITY_SERVICE);
        if (manager == null) return false;
        List<AccessibilityServiceInfo> enabled = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
        String expected = BraiAccessibilityService.class.getName();
        for (AccessibilityServiceInfo info : enabled) {
            if (info.getResolveInfo() != null && info.getResolveInfo().serviceInfo != null && expected.equals(info.getResolveInfo().serviceInfo.name)) {
                return true;
            }
        }
        return false;
    }

    private JSObject preliminaryStateJson(PreliminaryProfileResponse profile, String fingerprint) {
        JSObject state = stateJson();
        state.put("preliminaryStatus", profile.getStatus());
        state.put("preliminaryUserId", profile.getPreliminaryUserId());
        state.put("preliminaryClaimToken", profile.getPreliminaryClaimToken());
        state.put("duplicateDevice", profile.getDuplicateDevice());
        state.put("deviceFingerprint", fingerprint);
        return state;
    }

    private String deviceFingerprint() {
        String value = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        return value == null ? "" : value.trim();
    }

    private String cleanDisplayName(String value) {
        return value == null ? "" : value.trim();
    }

    private void startSettingsActivity(Intent intent) {
        if (getActivity() != null) {
            getActivity().startActivity(intent);
            return;
        }
        getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    public static void notifyOnboardingEvent(String type, String text) {
        BraiCmdPlugin plugin = activePlugin;
        if (plugin == null) return;
        MAIN_HANDLER.post(() -> plugin.notifyOnboardingEventNow(type, text));
    }

    public static void notifyCredentialRefreshRequired() {
        BraiCmdPlugin plugin = activePlugin;
        if (plugin == null) return;
        MAIN_HANDLER.post(() -> plugin.notifyListeners(EVENT_CREDENTIAL_REFRESH, new JSObject()));
    }

    private void notifyOnboardingEventNow(String type, String text) {
        JSObject event = new JSObject();
        event.put("type", type);
        if (text != null) event.put("text", text);
        notifyListeners(EVENT_ONBOARDING, event);
    }

    public static void notifyStateChanged() {
        BraiCmdPlugin plugin = activePlugin;
        if (plugin == null) return;
        MAIN_HANDLER.post(() -> plugin.notifyStateChangedNow(BraiCmdBridge.INSTANCE.snapshot(plugin.getContext())));
    }

    private void notifyStateChangedNow(JSObject snapshot) {
        if (snapshot != null) notifyListeners(EVENT_STATE_CHANGED, snapshot);
    }

    private static String providerMessage(Throwable error, String fallback) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) return fallback;
        return switch (message) {
            case "api_key_required" -> "Введите API-ключ";
            case "model_required" -> "Выберите модель";
            case "base_url_required" -> "Введите корректный Base URL";
            case "unsupported_provider" -> "Этот поставщик не поддерживается";
            default -> message;
        };
    }

    private static String providerCredentialSyncCode(Throwable error) {
        if (error instanceof ServerResponseException response) return response.getCode();
        String message = error.getMessage();
        if ("account_required".equals(message) || "account_changed".equals(message) ||
            "credential_operation_superseded".equals(message)) return message;
        return "provider_credentials_sync_failed";
    }

    private static String providerCredentialSyncMessage(Throwable error) {
        return switch (providerCredentialSyncCode(error)) {
            case "account_required" -> "Войдите в аккаунт Brai.";
            case "account_changed" -> "Аккаунт изменился во время синхронизации. Повторите попытку.";
            case "credential_operation_superseded" -> "Начата более новая синхронизация.";
            case "unauthorized" -> "Доступ устройства устарел. Переподключите Brai.";
            default -> "Не удалось синхронизировать ключи поставщиков.";
        };
    }

    private static String accountAccessCode(Throwable error) {
        if (error instanceof ServerResponseException response) return response.getCode();
        String message = error.getMessage();
        if ("invalid_user_id".equals(message) || "account_changed".equals(message) ||
            "invalid_link_token".equals(message) || "invalid_account_access_response".equals(message) ||
            "account_activation_required".equals(message) || "credential_operation_superseded".equals(message)) return message;
        return "account_access_failed";
    }

    private static void checkCurrentCredentialOperation(long generation) {
        if (!CREDENTIAL_OPERATIONS.isCurrent(generation)) {
            throw new IllegalStateException("credential_operation_superseded");
        }
    }

    private static void rejectAccountAccess(PluginCall call, Throwable error) {
        Exception exception = error instanceof Exception ? (Exception) error : new Exception(error);
        MAIN_HANDLER.post(() -> call.reject(
            "Не удалось сохранить доступ Brai",
            accountAccessCode(error),
            exception
        ));
    }
}
