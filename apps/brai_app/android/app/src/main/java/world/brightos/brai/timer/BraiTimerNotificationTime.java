package world.brightos.brai.timer;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;

final class BraiTimerNotificationTime {
    private static final String[] UTC_PATTERNS = {
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'"
    };

    private BraiTimerNotificationTime() {}

    static long startedAtMillis(String startedAtUtc, long fallbackMillis) {
        if (startedAtUtc == null) return fallbackMillis;

        String value = startedAtUtc.trim();
        for (String pattern : UTC_PATTERNS) {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
            format.setLenient(false);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            try {
                return format.parse(value).getTime();
            } catch (ParseException ignored) {
                // Try the next server timestamp shape.
            }
        }

        return fallbackMillis;
    }
}
