package world.brightos.brai.timer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import world.brightos.brai.BuildConfig;
import world.brightos.brai.MainActivity;
import world.brightos.brai.R;

public class BraiTimerNotificationService extends Service {
    public static final String ACTION_START = "world.brightos.brai.timer.START";
    public static final String ACTION_REQUEST_STOP = "world.brightos.brai.timer.REQUEST_STOP";
    public static final String ACTION_DISMISSED = "world.brightos.brai.timer.DISMISSED";
    public static final String EXTRA_STARTED_AT_UTC = "startedAtUtc";

    private static final String CHANNEL_ID = "brai_focus_timer";
    private static final int NOTIFICATION_ID = 1001;
    private static final long SYNC_INTERVAL_MS = 15_000;
    private static final int NETWORK_TIMEOUT_MS = 8_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Runnable syncRunnable = this::syncFromServer;
    private String startedAtUtc;
    private boolean destroyed;

    public static void stop(Context context) {
        context.stopService(new Intent(context, BraiTimerNotificationService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            startNotification(intent.getStringExtra(EXTRA_STARTED_AT_UTC));
            return START_STICKY;
        }

        if (ACTION_REQUEST_STOP.equals(action)) {
            requestServerStop();
            return START_STICKY;
        }

        if (ACTION_DISMISSED.equals(action)) {
            syncFromServer();
            return START_STICKY;
        }

        stopSelf();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        handler.removeCallbacks(syncRunnable);
        networkExecutor.shutdownNow();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startNotification(String nextStartedAtUtc) {
        if (nextStartedAtUtc == null || nextStartedAtUtc.trim().isEmpty()) {
            stopSelf();
            return;
        }

        startedAtUtc = nextStartedAtUtc.trim();
        showNotification();
        scheduleSync();
    }

    private void showNotification() {
        ensureChannel();
        Notification notification = buildNotification(startedAtUtc);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void requestServerStop() {
        handler.removeCallbacks(syncRunnable);
        networkExecutor.execute(() -> {
            BraiTimerServerState state = requestTimerState("POST", "/v1/timer/stop");
            if (!destroyed) handler.post(() -> applyServerState(state));
        });
    }

    private void syncFromServer() {
        networkExecutor.execute(() -> {
            BraiTimerServerState state = requestTimerState("GET", "/v1/timer/state");
            if (!destroyed) handler.post(() -> applyServerState(state));
        });
    }

    private void applyServerState(@Nullable BraiTimerServerState state) {
        if (destroyed) return;
        if (state == null) {
            scheduleSync();
            return;
        }

        if (state.activeStartedAtUtc == null) {
            stopSelf();
            return;
        }

        startedAtUtc = state.activeStartedAtUtc;
        showNotification();
        scheduleSync();
    }

    private void scheduleSync() {
        handler.removeCallbacks(syncRunnable);
        handler.postDelayed(syncRunnable, SYNC_INTERVAL_MS);
    }

    @Nullable
    private BraiTimerServerState requestTimerState(String method, String path) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(BuildConfig.BRAI_ANDROID_API.replaceAll("/$", "") + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(NETWORK_TIMEOUT_MS);
            connection.setReadTimeout(NETWORK_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/json");

            String cookie = CookieManager.getInstance().getCookie(BuildConfig.BRAI_ANDROID_API);
            if (cookie != null && !cookie.trim().isEmpty()) {
                connection.setRequestProperty("Cookie", cookie);
            }

            int status = connection.getResponseCode();
            if (status == 401 || status >= 500 || (status >= 400 && status != 409)) return null;

            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = readBody(stream);
            return body.trim().isEmpty() ? null : BraiTimerServerState.fromJson(body);
        } catch (IOException ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readBody(@Nullable InputStream input) throws IOException {
        if (input == null) return "";
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        }
        return body.toString();
    }

    private Notification buildNotification(String startedAtUtc) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        Intent stopIntent = new Intent(this, BraiTimerNotificationService.class);
        stopIntent.setAction(ACTION_REQUEST_STOP);

        Intent dismissedIntent = new Intent(this, BraiTimerNotificationService.class);
        dismissedIntent.setAction(ACTION_DISMISSED);

        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent dismissedPendingIntent = PendingIntent.getService(
            this,
            2,
            dismissedIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_timer_notification)
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher_foreground))
            .setContentTitle(getString(R.string.focus_timer_notification_title))
            .setContentText(getString(R.string.focus_timer_notification_text))
            .setContentIntent(openPendingIntent)
            .setDeleteIntent(dismissedPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(BraiTimerNotificationTime.startedAtMillis(startedAtUtc, System.currentTimeMillis()))
            .setUsesChronometer(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(
                R.drawable.ic_timer_notification,
                getString(R.string.focus_timer_notification_stop),
                stopPendingIntent
            )
            .build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.focus_timer_notification_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.focus_timer_notification_channel_description));
        manager.createNotificationChannel(channel);
    }
}

final class BraiTimerServerState {
    private static final Pattern ACTIVE_STARTED_AT_UTC = Pattern.compile(
        "\"active_session\"\\s*:\\s*\\{[^}]*\"started_at_utc\"\\s*:\\s*\"([^\"]+)\""
    );

    @Nullable
    final String activeStartedAtUtc;

    private BraiTimerServerState(@Nullable String activeStartedAtUtc) {
        this.activeStartedAtUtc = activeStartedAtUtc;
    }

    static BraiTimerServerState fromJson(String json) {
        // ponytail: one-field JSON read; use a JSON dependency if this native parser grows.
        Matcher matcher = ACTIVE_STARTED_AT_UTC.matcher(json);
        return new BraiTimerServerState(matcher.find() ? clean(matcher.group(1)) : null);
    }

    @Nullable
    private static String clean(@Nullable String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
