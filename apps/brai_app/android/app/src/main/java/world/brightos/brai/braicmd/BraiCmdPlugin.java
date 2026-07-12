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
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static volatile BraiCmdPlugin activePlugin;

    @Override
    public void load() {
        activePlugin = this;
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
        Intent intent = new Intent(getContext(), BraiCmdSettingsActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (getActivity() != null) {
            getActivity().startActivity(intent);
        } else {
            getContext().startActivity(intent);
        }
        call.resolve(stateJson());
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
    public void ensureAccess(PluginCall call) {
        ConfigStore config = new ConfigStore(getContext());
        String displayName = cleanDisplayName(call.getString("displayName", ""));
        if (!displayName.isBlank()) config.setDisplayName(displayName);
        if (!config.getAuthToken().isBlank()) {
            call.resolve(stateJson());
            return;
        }
        new Thread(() -> {
            try {
                String requestedName = config.getDisplayName().isBlank() ? "Brai" : config.getDisplayName();
                NetworkClient client = new NetworkClient(getContext());
                AccessResponse access = client.requestAccess(requestedName, deviceFingerprint());
                if (access.getToken().isBlank()) throw new IllegalStateException("Сервер не вернул токен");
                config.setAuthToken(access.getToken());
                config.setDisplayName(access.getDisplayName().isBlank() ? requestedName : access.getDisplayName());
                client.healthCheck();
            } catch (Throwable error) {
                config.setAuthToken("");
            }
            call.resolve(stateJson());
        }).start();
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
                call.reject(error.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void setAccessKey(PluginCall call) {
        ConfigStore config = new ConfigStore(getContext());
        config.setAuthToken(call.getString("token", ""));
        String displayName = cleanDisplayName(call.getString("displayName", ""));
        if (!displayName.isBlank()) config.setDisplayName(displayName);
        call.resolve(stateJson());
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
        state.put("accessGranted", !config.getAuthToken().isBlank());
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

    private void notifyOnboardingEventNow(String type, String text) {
        JSObject event = new JSObject();
        event.put("type", type);
        if (text != null) event.put("text", text);
        notifyListeners(EVENT_ONBOARDING, event);
    }
}
