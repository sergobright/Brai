package world.brightos.brai.ota;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BraiOtaVersionTest {
    @Test
    public void comparesWebBundleSequences() {
        assertTrue(BraiOtaVersion.compare("1.2.3+4.web.1", "1.2.3+4.web.0") > 0);
        assertTrue(BraiOtaVersion.compare("1.2.3+4.web.1", "1.2.3+4.web.1") == 0);
        assertTrue(BraiOtaVersion.compare("1.2.3+5.web.1", "1.2.3+4.web.9") > 0);
        assertTrue(BraiOtaVersion.compare("1.2.2+3.web.9", "1.2.3+4.web.0") < 0);
    }

    @Test
    public void comparesOtaVersions() {
        assertTrue(BraiOtaVersion.compare("0.0.2", "0.0.1") > 0);
        assertTrue(BraiOtaVersion.compare("0.1.0", "0.0.9") > 0);
        assertTrue(BraiOtaVersion.compare("0.0.1", "0.0.1") == 0);
    }

}
