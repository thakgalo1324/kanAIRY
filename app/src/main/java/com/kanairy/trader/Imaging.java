package com.kanairy.trader;

import android.graphics.Bitmap;

/** Image clean-up so small chart text reads like it was rendered at high resolution. */
final class Imaging {
    private Imaging() {}

    /** Upscale, stretch contrast, sharpen (unsharp mask). Optionally invert (white-on-black to black-on-white). */
    static Bitmap enhance(Bitmap src, float scale, boolean invert) {
        int w = Math.max(1, Math.round(src.getWidth() * scale)), h = Math.max(1, Math.round(src.getHeight() * scale));
        Bitmap big = Bitmap.createScaledBitmap(src, w, h, true);
        int[] px = new int[w * h];
        big.getPixels(px, 0, w, 0, 0, w, h);
        float[] g = new float[w * h];
        int[] hist = new int[256];
        for (int i = 0; i < px.length; i++) {
            int p = px[i];
            int l = (int) (0.299f * ((p >> 16) & 255) + 0.587f * ((p >> 8) & 255) + 0.114f * (p & 255));
            g[i] = l;
            hist[l]++;
        }
        int clip = px.length / 100, acc = 0, lo = 0, hi = 255;
        for (int i = 0; i < 256; i++) { acc += hist[i]; if (acc > clip) { lo = i; break; } }
        acc = 0;
        for (int i = 255; i >= 0; i--) { acc += hist[i]; if (acc > clip) { hi = i; break; } }
        float span = Math.max(1, hi - lo);
        for (int i = 0; i < g.length; i++) g[i] = Math.max(0f, Math.min(1f, (g[i] - lo) / span));
        float[] out = new float[g.length];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = y * w + x;
                if (x == 0 || y == 0 || x == w - 1 || y == h - 1) { out[i] = g[i]; continue; }
                float blur = (g[i - w - 1] + g[i - w] + g[i - w + 1] + g[i - 1] + g[i] + g[i + 1] + g[i + w - 1] + g[i + w] + g[i + w + 1]) / 9f;
                out[i] = Math.max(0f, Math.min(1f, g[i] + 1.2f * (g[i] - blur)));
            }
        }
        for (int i = 0; i < px.length; i++) {
            int v = Math.round((invert ? 1f - out[i] : out[i]) * 255f);
            px[i] = 0xFF000000 | (v << 16) | (v << 8) | v;
        }
        Bitmap res = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        res.setPixels(px, 0, w, 0, 0, w, h);
        if (big != src) big.recycle();
        return res;
    }
}
