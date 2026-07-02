package world.brightos.brai.timer;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(
    name = "BraiTimerNotification",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BraiTimerNotificationPlugin extends Plugin {
    private static final AtomicBoolean STOP_REQUESTED = new AtomicBoolean(false);

    public static void requestStopFromNotification() {
        STOP_REQUESTED.set(true);
    }

    public static void clearStopRequest() {
        STOP_REQUESTED.set(false);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String startedAtUtc = call.getString("startedAtUtc");
        if (startedAtUtc == null || startedAtUtc.trim().isEmpty()) {
            call.reject("startedAtUtc_required");
            return;
        }

        if (needsNotificationPermission()) {
            requestPermissionForAlias("notifications", call, "startAfterPermission");
            return;
        }

        startService(call);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        if (needsNotificationPermission()) {
            call.reject("notification_permission_denied");
            return;
        }
        startService(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        BraiTimerNotificationService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void consumeStopRequest(PluginCall call) {
        JSObject result = new JSObject();
        result.put("requested", STOP_REQUESTED.getAndSet(false));
        call.resolve(result);
    }

    private boolean needsNotificationPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED;
    }

    private void startService(PluginCall call) {
        Intent intent = new Intent(getContext(), BraiTimerNotificationService.class);
        intent.setAction(BraiTimerNotificationService.ACTION_START);
        intent.putExtra(
            BraiTimerNotificationService.EXTRA_STARTED_AT_UTC,
            call.getString("startedAtUtc")
        );
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }
}
