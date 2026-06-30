package world.brightos.bright_os_client.timer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class BrightTimerServerStateTest {
    @Test
    public void readsActiveStartFromTimerState() {
        BrightTimerServerState state = BrightTimerServerState.fromJson(
            "{\"active_session\":{\"started_at_utc\":\"2026-06-30T10:00:00.000Z\"}}"
        );

        assertEquals("2026-06-30T10:00:00.000Z", state.activeStartedAtUtc);
    }

    @Test
    public void treatsMissingActiveSessionAsStopped() {
        BrightTimerServerState state = BrightTimerServerState.fromJson("{\"active_session\":null}");

        assertNull(state.activeStartedAtUtc);
    }
}
