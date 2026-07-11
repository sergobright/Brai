package world.brightos.brai;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.ServerPath;

import world.brightos.brai.capabilities.BraiAndroidCapabilitiesPlugin;
import world.brightos.brai.braicmd.BraiCmdPlugin;
import world.brightos.brai.braicmd.ConfigStore;
import world.brightos.brai.ota.BraiOtaManager;
import world.brightos.brai.ota.BraiOtaPlugin;
import world.brightos.brai.ota.BraiOtaRegistry;
import world.brightos.brai.ota.BraiOtaWebViewClient;
import world.brightos.brai.timer.BraiTimerNotificationPlugin;
import world.brightos.brai.timer.BraiTimerNotificationService;
import world.brightos.brai.widget.BraiActionsWidgetPlugin;

public class MainActivity extends BridgeActivity {
    private static final int STARTUP_BACKGROUND = Color.BLACK;
    private static final String HANDLE_ANDROID_BACK_SCRIPT =
        "(function(){try{return !!(window.BraiAndroidBack&&window.BraiAndroidBack());}catch(e){return false;}})();";
    private static final String HANDLE_TIMER_STOP_SCRIPT =
        "(function(){try{return !!(window.BraiAndroidTimerStop&&window.BraiAndroidTimerStop());}catch(e){return false;}})();";

    private BraiOtaManager otaManager;
    private OnBackPressedCallback androidBackCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        new ConfigStore(this).setOnboardingVoiceOnly(true);
        getWindow().setBackgroundDrawable(new ColorDrawable(STARTUP_BACKGROUND));
        getWindow().setStatusBarColor(STARTUP_BACKGROUND);
        getWindow().setNavigationBarColor(STARTUP_BACKGROUND);

        otaManager = new BraiOtaManager(this);
        BraiOtaRegistry.setManager(otaManager);

        ServerPath startupPath = otaManager.startupServerPath();
        if (startupPath != null) {
            bridgeBuilder.setServerPath(startupPath);
        }
        registerPlugin(BraiCmdPlugin.class);
        registerPlugin(BraiAndroidCapabilitiesPlugin.class);
        registerPlugin(BraiOtaPlugin.class);
        registerPlugin(BraiTimerNotificationPlugin.class);
        registerPlugin(BraiActionsWidgetPlugin.class);

        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(STARTUP_BACKGROUND);
        }

        androidBackCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleAndroidBack();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, androidBackCallback);

        otaManager.attachBridge(getBridge());
        getBridge().setWebViewClient(new BraiOtaWebViewClient(getBridge(), otaManager));
        otaManager.checkForUpdatesAsync();
        handleTimerNotificationIntent(getIntent());
    }

    @Override
    public void onDestroy() {
        if (otaManager != null) {
            BraiOtaRegistry.clearManager(otaManager);
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        handleAndroidBack();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleTimerNotificationIntent(intent);
    }

    private void handleAndroidBack() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            runDefaultBack();
            return;
        }

        getBridge().getWebView().evaluateJavascript(HANDLE_ANDROID_BACK_SCRIPT, handled -> {
            if (!"true".equals(handled)) {
                runDefaultBack();
            }
        });
    }

    private void runDefaultBack() {
        if (androidBackCallback == null) {
            super.onBackPressed();
            return;
        }

        try {
            androidBackCallback.setEnabled(false);
            getOnBackPressedDispatcher().onBackPressed();
        } finally {
            androidBackCallback.setEnabled(true);
        }
    }

    private void handleTimerNotificationIntent(Intent intent) {
        if (intent == null || !BraiTimerNotificationService.ACTION_REQUEST_STOP.equals(intent.getAction())) {
            return;
        }

        BraiTimerNotificationPlugin.requestStopFromNotification();
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        getBridge().getWebView().evaluateJavascript(HANDLE_TIMER_STOP_SCRIPT, handled -> {
            if ("true".equals(handled)) {
                BraiTimerNotificationPlugin.clearStopRequest();
            }
        });
    }
}
