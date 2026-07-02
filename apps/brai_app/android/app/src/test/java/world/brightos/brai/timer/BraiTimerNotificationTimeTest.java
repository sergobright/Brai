package world.brightos.brai.timer;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class BraiTimerNotificationTimeTest {
    @Test
    public void parsesUtcTimerStart() {
        assertEquals(1781999707000L, BraiTimerNotificationTime.startedAtMillis("2026-06-20T23:55:07.000Z", 42L));
        assertEquals(1781999707000L, BraiTimerNotificationTime.startedAtMillis("2026-06-20T23:55:07Z", 42L));
    }

    @Test
    public void fallsBackForInvalidTimestamp() {
        assertEquals(42L, BraiTimerNotificationTime.startedAtMillis("not-a-date", 42L));
    }
}
