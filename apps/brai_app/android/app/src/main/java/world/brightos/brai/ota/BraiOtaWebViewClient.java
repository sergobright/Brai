package world.brightos.brai.ota;

import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

public final class BraiOtaWebViewClient extends BridgeWebViewClient {
    private final BraiOtaManager manager;

    public BraiOtaWebViewClient(Bridge bridge, BraiOtaManager manager) {
        super(bridge);
        this.manager = manager;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request != null && request.isForMainFrame()) {
            manager.handleCandidateLoadFailure("main_frame_load_error");
        }
        super.onReceivedError(view, request, error);
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request != null && request.isForMainFrame()) {
            manager.handleCandidateLoadFailure("main_frame_http_error");
        }
        super.onReceivedHttpError(view, request, errorResponse);
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        manager.handleCandidateLoadFailure("webview_render_process_gone");
        return super.onRenderProcessGone(view, detail);
    }
}
