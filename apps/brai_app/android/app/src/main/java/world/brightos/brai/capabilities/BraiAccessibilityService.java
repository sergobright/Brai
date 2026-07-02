package world.brightos.brai.capabilities;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;

public final class BraiAccessibilityService extends AccessibilityService {
    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}
}
