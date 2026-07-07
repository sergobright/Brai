package world.brightos.brai.capabilities;

import android.Manifest;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BraiAndroidCapabilities",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public final class BraiAndroidCapabilitiesPlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(stateJson());
    }

    @PluginMethod
    public void requestMicrophone(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(stateJson());
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionResult");
    }

    @PermissionCallback
    private void microphonePermissionResult(PluginCall call) {
        call.resolve(stateJson());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(stateJson());
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsPermissionResult");
    }

    @PermissionCallback
    private void notificationsPermissionResult(PluginCall call) {
        call.resolve(stateJson());
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())
            );
            startSettingsActivity(intent);
        }
        call.resolve(stateJson());
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        startSettingsActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        call.resolve(stateJson());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName())
        );
        startSettingsActivity(intent);
        call.resolve(stateJson());
    }

    private JSObject stateJson() {
        JSObject state = new JSObject();
        state.put("overlayDeclared", hasRequestedPermission(Manifest.permission.SYSTEM_ALERT_WINDOW));
        state.put("overlayGranted", canDrawOverlays());
        state.put("microphoneDeclared", hasRequestedPermission(Manifest.permission.RECORD_AUDIO));
        state.put("microphoneGranted", getPermissionState("microphone") == PermissionState.GRANTED);
        state.put("notificationsDeclared", hasRequestedPermission(Manifest.permission.POST_NOTIFICATIONS));
        state.put("notificationsGranted", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED);
        state.put("microphoneForegroundServiceDeclared", hasRequestedPermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE));
        state.put("mediaProjectionDeclared", hasRequestedPermission(Manifest.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION));
        state.put("mediaProjectionServiceDeclared", hasService(BraiMediaProjectionService.class));
        state.put("mediaProjectionServiceTypeDeclared", hasService(BraiMediaProjectionService.class));
        state.put("microphoneServiceTypeDeclared", hasService(BraiMediaProjectionService.class));
        state.put("accessibilityServiceDeclared", hasService(BraiAccessibilityService.class));
        state.put("accessibilityServiceEnabled", isAccessibilityServiceEnabled());
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
            getServiceInfo(serviceClass);
            return true;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    private android.content.pm.ServiceInfo getServiceInfo(Class<?> serviceClass) throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getServiceInfo(
            new ComponentName(getContext(), serviceClass),
            PackageManager.GET_META_DATA
        );
    }

    private void startSettingsActivity(Intent intent) {
        if (getActivity() != null) {
            getActivity().startActivity(intent);
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private boolean isAccessibilityServiceEnabled() {
        String enabled = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (enabled == null || enabled.trim().isEmpty()) return false;

        String expected = new ComponentName(getContext(), BraiAccessibilityService.class).flattenToString();
        for (String service : enabled.split(":")) {
            if (expected.equalsIgnoreCase(service.trim())) return true;
        }
        return false;
    }
}
