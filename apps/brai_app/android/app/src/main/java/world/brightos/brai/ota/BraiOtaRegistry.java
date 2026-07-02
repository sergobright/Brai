package world.brightos.brai.ota;

public final class BraiOtaRegistry {
    private static BraiOtaManager manager;

    private BraiOtaRegistry() {}

    public static synchronized void setManager(BraiOtaManager nextManager) {
        manager = nextManager;
    }

    public static synchronized BraiOtaManager getManager() {
        return manager;
    }

    public static synchronized void clearManager(BraiOtaManager currentManager) {
        if (manager == currentManager) {
            manager = null;
        }
    }
}
