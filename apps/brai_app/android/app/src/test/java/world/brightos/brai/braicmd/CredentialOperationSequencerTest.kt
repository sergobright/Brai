package world.brightos.brai.braicmd

import java.util.ArrayDeque
import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Test

class CredentialOperationSequencerTest {
    @Test
    fun runsCredentialOperationsInFifoOrderAndRejectsSupersededSameUserWork() {
        val scheduled = ArrayDeque<Runnable>()
        val sequencer = CredentialOperationSequencer(Executor { scheduled.addLast(it) })
        val observed = mutableListOf<String>()
        val applied = mutableListOf<String>()

        val firstGeneration = sequencer.enqueue { generation ->
            observed += "first"
            if (sequencer.isCurrent(generation)) applied += "stale-sync"
        }
        val secondGeneration = sequencer.enqueue { generation ->
            observed += "second"
            if (sequencer.isCurrent(generation)) applied += "latest-sync"
        }

        while (scheduled.isNotEmpty()) scheduled.removeFirst().run()

        assertEquals(1L, firstGeneration)
        assertEquals(2L, secondGeneration)
        assertEquals(listOf("first", "second"), observed)
        assertEquals(listOf("latest-sync"), applied)
    }
}
