package world.brightos.brai.braicmd;

import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
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
    @PluginMethod
    public void getState(PluginCall call) {
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
        config.setOnboardingVoiceOnly(call.getBoolean("enabled", false));
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

    private void startSettingsActivity(Intent intent) {
        if (getActivity() != null) {
            getActivity().startActivity(intent);
            return;
        }
        getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
}
