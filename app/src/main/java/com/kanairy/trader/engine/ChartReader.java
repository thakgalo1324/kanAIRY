package com.kanairy.trader.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Reads candles straight from screenshot pixels. No Android dependencies. */
public final class ChartReader {
    public static final int AUTO = 0, GREEN_RED = 1, BLUE_RED = 2, GREEN_BLUE = 3, RED_GREEN = 4;
    private static final int NONE = 0, G = 1, R = 2, B = 3;

    public static final class Px {
        public int x, width, yHigh, yLow, yBodyTop, yBodyBot;
        public boolean bull;
    }

    public static final class Result {
        public final List<Px> candles = new ArrayList<>();
        public int medianWidth;
        public String colors = "";
    }

    static int cls(int c) {
        int r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
        int mx = Math.max(r, Math.max(g, b));
        if (mx < 110) return NONE;
        if (g == mx && g - r >= 50 && g - b >= 40) return G;
        if (r == mx && r - g >= 70 && r - b >= 50) return R;
        if (b == mx && b - r >= 70 && b - g >= 20) return B;
        return NONE;
    }

    public static Result read(int[] p, int w, int h, int x0, int y0, int x1, int y1, int preset) {
        Result res = new Result();
        int rw = x1 - x0, rh = y1 - y0;
        if (rw < 50 || rh < 50) return res;
        byte[] k = new byte[rw * rh];
        for (int y = 0; y < rh; y++)
            for (int x = 0; x < rw; x++) k[y * rw + x] = (byte) cls(p[(y + y0) * w + x + x0]);

        // drop long horizontal lines (price line, SL/TP lines, grid in candle colours)
        for (int y = 0; y < rh; y++) {
            int c = 0;
            for (int x = 0; x < rw; x++) if (k[y * rw + x] != 0) c++;
            if (c > 0.6 * rw) Arrays.fill(k, y * rw, y * rw + rw, (byte) 0);
        }
        int[] cnt = new int[4];
        for (byte v : k) cnt[v]++;
        int total = cnt[G] + cnt[R] + cnt[B];
        if (total < 40) return res;

        int bull, bear;
        switch (preset) {
            case GREEN_RED: bull = G; bear = R; break;
            case BLUE_RED: bull = B; bear = R; break;
            case GREEN_BLUE: bull = G; bear = B; break;
            case RED_GREEN: bull = R; bear = G; break;
            default: {
                boolean sg = cnt[G] > 0.15 * total, sr = cnt[R] > 0.15 * total, sb = cnt[B] > 0.15 * total;
                if (sr && sg) { bull = G; bear = R; }
                else if (sr && sb) { bull = B; bear = R; }
                else if (sg && sb) { bull = G; bear = B; }
                else if (cnt[R] > 0) { bear = R; bull = cnt[G] >= cnt[B] ? G : B; }
                else return res;
            }
        }
        res.colors = name(bull) + " up / " + name(bear) + " down";

        int[] cMin = new int[rw], cMax = new int[rw], cBull = new int[rw], cBear = new int[rw];
        Arrays.fill(cMin, Integer.MAX_VALUE); Arrays.fill(cMax, -1);
        for (int x = 0; x < rw; x++)
            for (int y = 0; y < rh; y++) {
                int v = k[y * rw + x];
                if (v == bull) cBull[x]++; else if (v == bear) cBear[x]++; else continue;
                if (y < cMin[x]) cMin[x] = y;
                if (y > cMax[x]) cMax[x] = y;
            }

        // group contiguous same-colour columns
        List<int[]> groups = new ArrayList<>(); // xs, xe, isBull
        int gs = -1, gc = -1;
        for (int x = 0; x <= rw; x++) {
            int c = -1;
            if (x < rw && cBull[x] + cBear[x] > 0) c = cBull[x] >= cBear[x] ? 1 : 0;
            if (gs >= 0 && c != gc) { groups.add(new int[]{gs, x - 1, gc}); gs = -1; }
            if (c >= 0 && gs < 0) { gs = x; gc = c; }
        }
        if (groups.isEmpty()) return res;

        int[] ws = new int[groups.size()];
        for (int i = 0; i < ws.length; i++) ws[i] = groups.get(i)[1] - groups.get(i)[0] + 1;
        int[] sorted = ws.clone(); Arrays.sort(sorted);
        int med = sorted[sorted.length / 2];
        res.medianWidth = med;

        for (int[] g : groups) {
            int gw = g[1] - g[0] + 1;
            if (gw > 40) continue;
            int parts = (med >= 3 && gw >= 2.2 * med) ? (int) Math.round((double) gw / med) : 1;
            for (int s = 0; s < parts; s++) {
                int xs = g[0] + s * gw / parts, xe = g[0] + (s + 1) * gw / parts - 1;
                if (xe < xs) continue;
                Px c = build(k, rw, rh, cMin, cMax, xs, xe, g[2] == 1, bull, bear, x0, y0);
                if (c != null) res.candles.add(c);
            }
        }
        return res;
    }

    private static Px build(byte[] k, int rw, int rh, int[] cMin, int[] cMax, int xs, int xe,
                            boolean isBull, int bull, int bear, int x0, int y0) {
        int hi = Integer.MAX_VALUE, lo = -1;
        for (int x = xs; x <= xe; x++) {
            if (cMax[x] < 0) continue;
            hi = Math.min(hi, cMin[x]); lo = Math.max(lo, cMax[x]);
        }
        if (lo < 0) return null;
        int w = xe - xs + 1;
        if (lo - hi < 1 && w < 3) return null;
        int want = isBull ? bull : bear;
        int bt = -1, bb = -1;
        if (w >= 3) {
            int thr = Math.max(2, (int) Math.round(w * 0.5));
            for (int y = hi; y <= lo; y++) {
                int c = 0;
                for (int x = xs; x <= xe; x++) if (k[y * rw + x] == want) c++;
                if (c >= thr) { if (bt < 0) bt = y; bb = y; }
            }
        }
        if (bt < 0) { bt = hi; bb = lo; }
        Px p = new Px();
        p.x = x0 + (xs + xe) / 2; p.width = w; p.bull = isBull;
        p.yHigh = y0 + hi; p.yLow = y0 + lo; p.yBodyTop = y0 + bt; p.yBodyBot = y0 + bb;
        return p;
    }

    private static String name(int c) { return c == G ? "green" : c == R ? "red" : "blue"; }

    /** Convert pixel candles to price candles using the fitted axis. y grows downward. */
    public static List<Candle> toPrices(List<Px> px, PriceScale s) {
        List<Candle> out = new ArrayList<>();
        for (Px p : px) {
            double top = s.price(p.yBodyTop), bot = s.price(p.yBodyBot + 1);
            double hi = s.price(p.yHigh), lo = s.price(p.yLow + 1);
            double o = p.bull ? bot : top, c = p.bull ? top : bot;
            out.add(new Candle(o, Math.max(hi, Math.max(o, c)), Math.min(lo, Math.min(o, c)), c, p.x));
        }
        return out;
    }
}
