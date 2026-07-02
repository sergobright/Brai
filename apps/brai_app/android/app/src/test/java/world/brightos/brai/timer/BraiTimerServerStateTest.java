package world.brightos.brai.timer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class BraiTimerServerStateTest {
    @Test
    public void readsActiveStartFromTimerState() {
        BraiTimerServerState state = BraiTimerServerState.fromJson(
            "{\"active_session\":{\"started_at_utc\":\"2026-06-30T10:00:00.000Z\"}}"
        );

        assertEquals("2026-06-30T10:00:00.000Z", state.activeStartedAtUtc);
    }

    @Test
    public void treatsMissingActiveSessionAsStopped() {
        BraiTimerServerState state = BraiTimerServerState.fromJson("{\"active_session\":null}");

        assertNull(state.activeStartedAtUtc);
    }
}
