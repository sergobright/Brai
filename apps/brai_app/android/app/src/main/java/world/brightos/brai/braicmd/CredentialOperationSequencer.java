package world.brightos.brai.braicmd;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

final class CredentialOperationSequencer {
    interface Operation {
        void run(long generation);
    }

    private final Executor executor;
    private final AtomicLong generation = new AtomicLong();

    CredentialOperationSequencer(Executor executor) {
        this.executor = executor;
    }

    static CredentialOperationSequencer createDefault() {
        return new CredentialOperationSequencer(Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "brai-cmd-credentials");
            thread.setDaemon(true);
            return thread;
        }));
    }

    long enqueue(Operation operation) {
        long next = generation.incrementAndGet();
        executor.execute(() -> operation.run(next));
        return next;
    }

    void enqueueMaintenance(Runnable operation) {
        executor.execute(operation);
    }

    boolean isCurrent(long expectedGeneration) {
        return generation.get() == expectedGeneration;
    }
}
