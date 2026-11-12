package com.kanairy.trader;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.hardware.HardwareBuffer;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Everything lives here: floating overlay, screen capture (takeScreenshot), taps and node access.
 * One accessibility service, no VPS, no cloud, no extra permissions.
 */
public class KanairyService extends AccessibilityService {
    public static volatile KanairyService instance;

    public static final class Shot {
        public Bitmap bmp;
        public int[] px;
        public int w, h;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private Overlay overlay;
    private Bot bot;
    private LabEngine lab;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        lab = new LabEngine(this);
        bot = new Bot(this, lab);
        overlay = new Overlay(this, bot);
        bot.attach(overlay);
        bot.start();
        Flog.i("Kanairy ready. Open an MT5 chart.");
        if (Cfg.b(this, Cfg.AUTO_SHOW, true)) showOverlay();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }

    @Override public void onInterrupt() { }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        if (bot != null) bot.stop();
        main.post(() -> { if (overlay != null) overlay.remove(); });
        return super.onUnbind(intent);
    }

    public void showOverlay() { main.post(() -> { if (overlay != null) overlay.show(); }); }

    public Handler mainHandler() { return main; }

    Bot bot() { return bot; }

    Overlay overlay() { return overlay; }

    /** Real display bounds in pixels (same space as screenshots and gestures). */
    public android.graphics.Rect screen() {
        android.view.WindowManager wm = (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
        return wm.getMaximumWindowMetrics().getBounds();
    }

    /** Two-finger horizontal pinch centred at (cx, cy). zoomIn spreads the fingers. Blocking. */
    public boolean pinch(float cx, float cy, float startHalf, float endHalf, long ms) {
        Path a = new Path(), b = new Path();
        a.moveTo(cx - startHalf, cy); a.lineTo(cx - endHalf, cy);
        b.moveTo(cx + startHalf, cy); b.lineTo(cx + endHalf, cy);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(a, 0, ms))
                .addStroke(new GestureDescription.StrokeDescription(b, 0, ms)).build();
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = new boolean[1];
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { ok[0] = true; latch.countDown(); }
            @Override public void onCancelled(GestureDescription d) { latch.countDown(); }
        }, null);
        if (!sent) return false;
        try { latch.await(4, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return ok[0];
    }

    /** Blocking screenshot of the whole display. Call from a worker thread only. */
    public Shot screenshot() {
        final CountDownLatch latch = new CountDownLatch(1);
        final Shot[] out = new Shot[1];
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, exec, new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult r) {
                    try {
                        HardwareBuffer hb = r.getHardwareBuffer();
                        Bitmap hw = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                        if (hw != null) {
                            Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
                            hw.recycle();
                            Shot s = new Shot();
                            s.bmp = sw; s.w = sw.getWidth(); s.h = sw.getHeight();
                            s.px = new int[s.w * s.h];
                            sw.getPixels(s.px, 0, s.w, 0, 0, s.w, s.h);
                            out[0] = s;
                        }
                        hb.close();
                    } catch (Exception e) {
                        Flog.i("screenshot convert failed: " + e.getMessage());
                    }
                    latch.countDown();
                }

                @Override public void onFailure(int errorCode) {
                    Flog.i("screenshot failed code " + errorCode);
                    latch.countDown();
                }
            });
            latch.await(5, TimeUnit.SECONDS);
        } catch (Exception e) {
            Flog.i("screenshot error: " + e.getMessage());
        }
        return out[0];
    }

    /** Blocking tap at screen coordinates. */
    public boolean tap(float x, float y) {
        Path p = new Path();
        p.moveTo(x, y);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 60)).build();
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = new boolean[1];
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { ok[0] = true; latch.countDown(); }
            @Override public void onCancelled(GestureDescription d) { latch.countDown(); }
        }, null);
        if (!sent) return false;
        try { latch.await(3, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return ok[0];
    }
}
