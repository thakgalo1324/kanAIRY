package com.kanairy.trader.engine;

/** Indicators over arrays; index 0 = oldest. */
public final class Ind {
    private Ind() {}

    public static double[] ema(double[] v, int n) {
        double[] o = new double[v.length];
        if (v.length == 0) return o;
        double k = 2.0 / (n + 1);
        o[0] = v[0];
        for (int i = 1; i < v.length; i++) o[i] = v[i] * k + o[i - 1] * (1 - k);
        return o;
    }

    public static double[] rsi(double[] v, int n) {
        double[] o = new double[v.length];
        java.util.Arrays.fill(o, 50);
        if (v.length <= n) return o;
        double g = 0, l = 0;
        for (int i = 1; i <= n; i++) {
            double d = v[i] - v[i - 1];
            if (d > 0) g += d; else l -= d;
        }
        g /= n; l /= n;
        o[n] = l == 0 ? 100 : 100 - 100 / (1 + g / l);
        for (int i = n + 1; i < v.length; i++) {
            double d = v[i] - v[i - 1];
            g = (g * (n - 1) + Math.max(d, 0)) / n;
            l = (l * (n - 1) + Math.max(-d, 0)) / n;
            o[i] = l == 0 ? 100 : 100 - 100 / (1 + g / l);
        }
        return o;
    }

    public static double[] atr(Candle[] c, int n) {
        double[] o = new double[c.length];
        if (c.length == 0) return o;
        double[] tr = new double[c.length];
        tr[0] = c[0].h - c[0].l;
        for (int i = 1; i < c.length; i++) {
            double pc = c[i - 1].c;
            tr[i] = Math.max(c[i].h - c[i].l, Math.max(Math.abs(c[i].h - pc), Math.abs(c[i].l - pc)));
        }
        double sum = 0;
        for (int i = 0; i < c.length; i++) {
            if (i < n) { sum += tr[i]; o[i] = sum / (i + 1); }
            else o[i] = (o[i - 1] * (n - 1) + tr[i]) / n;
        }
        return o;
    }

    public static double[] macdHist(double[] v) {
        double[] a = ema(v, 12), b = ema(v, 26), m = new double[v.length];
        for (int i = 0; i < v.length; i++) m[i] = a[i] - b[i];
        double[] s = ema(m, 9), h = new double[v.length];
        for (int i = 0; i < v.length; i++) h[i] = m[i] - s[i];
        return h;
    }
}
