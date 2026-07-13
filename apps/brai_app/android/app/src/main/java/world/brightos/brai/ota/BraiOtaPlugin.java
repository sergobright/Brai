package world.brightos.brai.ota;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BraiOta")
public final class BraiOtaPlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        BraiOtaManager manager = BraiOtaRegistry.getManager();
        if (manager == null) {
            call.reject("ota_manager_unavailable");
            return;
        }
        call.resolve(manager.stateJson());
    }

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        BraiOtaManager manager = BraiOtaRegistry.getManager();
        if (manager == null) {
            call.reject("ota_manager_unavailable");
            return;
        }
        boolean started = manager.checkForUpdatesAsync();
        JSObject response = manager.stateJson();
        response.put("started", started);
        call.resolve(response);
    }

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        BraiOtaManager manager = BraiOtaRegistry.getManager();
        if (manager == null) {
            call.reject("ota_manager_unavailable");
            return;
        }
        boolean started = manager.downloadUpdateAsync();
        JSObject response = manager.stateJson();
        response.put("started", started);
        call.resolve(response);
    }

    @PluginMethod
    public void downloadApk(PluginCall call) {
        BraiOtaManager manager = BraiOtaRegistry.getManager();
        if (manager == null) {
            call.reject("ota_manager_unavailable");
            return;
        }
        boolean started = manager.downloadApk();
        JSObject response = manager.stateJson();
        response.put("started", started);
        call.resolve(response);
    }

    @PluginMethod
    public void markReady(PluginCall call) {
        BraiOtaManager manager = BraiOtaRegistry.getManager();
        if (manager == null) {
            call.reject("ota_manager_unavailable");
            return;
        }
        String bundleVersion = call.getString("bundleVersion");
        boolean promoted = manager.markReady(bundleVersion);
        JSObject response = manager.stateJson();
        response.put("promoted", promoted);
        call.resolve(response);
    }
}
