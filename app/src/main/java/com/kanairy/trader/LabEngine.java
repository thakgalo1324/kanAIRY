package com.kanairy.trader;

import android.content.Context;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Runs the Strategy lab's own JavaScript (strategy.js + indicators.js) in a hidden WebView,
 * so any XML strategy the user activates is evaluated exactly as it is in the lab.
 */
final class LabEngine {
    private final KanairyService svc;
    private WebView wv;
    private volatile boolean ready;

    LabEngine(KanairyService svc) {
        this.svc = svc;
        svc.mainHandler().post(this::init);
    }

    private void init() {
        try {
            Context app = svc.getApplicationContext();
            wv = new WebView(app);
            WebSettings ws = wv.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setAllowFileAccess(false);
            final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                    .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(app)).build();
            wv.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                    return loader.shouldInterceptRequest(r.getUrl());
                }
                @Override public void onPageFinished(WebView v, String url) { ready = true; }
            });
            wv.loadUrl("https://appassets.androidplatform.net/assets/web/engine.html");
        } catch (Throwable t) {
            Flog.i("strategy engine failed to start: " + t.getMessage());
        }
    }

    boolean ready() { return ready; }

    /** Returns the engine's JSON answer, or null if it is not ready or timed out. */
    String eval(String candlesJson, String strategyJson) {
        if (!ready || wv == null) return null;
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] out = new String[1];
        svc.mainHandler().post(() -> {
            try {
                String js = "window.__eval(" + JSONObject.quote(candlesJson) + "," + JSONObject.quote(strategyJson) + ")";
                wv.evaluateJavascript(js, v -> { out[0] = v; latch.countDown(); });
            } catch (Throwable t) { latch.countDown(); }
        });
        try { if (!latch.await(8, TimeUnit.SECONDS)) return null; } catch (InterruptedException e) { return null; }
        if (out[0] == null) return null;
        try {
            Object v = new JSONTokener(out[0]).nextValue();
            return v instanceof String ? (String) v : null;
        } catch (Exception e) { return null; }
    }
}
