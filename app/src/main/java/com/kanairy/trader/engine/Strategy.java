package com.kanairy.trader.engine;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Confluence scoring: trend + momentum + candle patterns + structure. Closed candles only. */
public final class Strategy {
    public static final class Params {
        public int threshold = 4;
        public double slAtr = 1.5;
        public double rr = 2.0;
        public boolean scalp = false;
    }

    public static final class Decision {
        public String action = "WAIT";
        public int score;
        public double entry, sl, tp, rsi, atr;
        public int decimals = 5;
        public String why = "";
        public String key = "";
    }

    public static Decision decide(List<Candle> all, Params p, int decimals) {
        Decision d = new Decision();
        d.decimals = decimals;
        int n = all.size() - 1; // last candle is still forming
        if (n < 40) { d.why = "need 40+ closed candles, saw " + Math.max(n, 0); return d; }
        Candle[] c = new Candle[n];
        double[] cl = new double[n];
        for (int i = 0; i < n; i++) { c[i] = all.get(i); cl[i] = c[i].c; }
        double forming = all.get(n).c;
        double[] e20 = Ind.ema(cl, p.scalp ? 9 : 20), e50 = Ind.ema(cl, p.scalp ? 21 : 50), rsi = Ind.rsi(cl, 14);
        double[] atr = Ind.atr(c, 14), hist = Ind.macdHist(cl);
        int i = n - 1;
        double a = atr[i];
        if (!(a > 0)) { d.why = "flat chart"; return d; }
        d.atr = a; d.rsi = rsi[i];

        int s = 0;
        List<String> why = new ArrayList<>();

        boolean up = e20[i] > e50[i] && cl[i] > e50[i];
        boolean dn = e20[i] < e50[i] && cl[i] < e50[i];
        double slope = (e50[i] - e50[i - 5]) / a;
        if (up) { int v = slope > 0.1 ? 2 : 1; s += v; why.add("uptrend +" + v); }
        else if (dn) { int v = slope < -0.1 ? 2 : 1; s -= v; why.add("downtrend -" + v); }

        if (hist[i] > 0 && hist[i] > hist[i - 1]) { s += 1; why.add("macd up +1"); }
        else if (hist[i] < 0 && hist[i] < hist[i - 1]) { s -= 1; why.add("macd down -1"); }

        double r = rsi[i];
        if (r >= 52 && r <= 70) { s += 1; why.add("rsi bull +1"); }
        else if (r <= 48 && r >= 30) { s -= 1; why.add("rsi bear -1"); }
        else if (r > 75) { s -= 1; why.add("rsi overbought -1"); }
        else if (r < 25) { s += 1; why.add("rsi oversold +1"); }

        String[] pn = new String[1];
        int pat = pattern(c, i, a, pn);
        if (pat != 0) { s += pat; why.add(pn[0] + (pat > 0 ? " +" : " ") + pat); }

        // breakout of the last 20 bars (excluding the last 2)
        int look = p.scalp ? 10 : 20;
        int from = Math.max(0, i - look - 1), to = i - 2;
        double hh = -Double.MAX_VALUE, ll = Double.MAX_VALUE;
        for (int k = from; k <= to; k++) { hh = Math.max(hh, c[k].h); ll = Math.min(ll, c[k].l); }
        boolean breakout = false;
        if (cl[i] > hh && c[i].body() >= 0.6 * a) { s += 2; breakout = true; why.add("breakout up +2"); }
        else if (cl[i] < ll && c[i].body() >= 0.6 * a) { s -= 2; breakout = true; why.add("breakdown -2"); }

        // support / resistance from swing pivots
        if (!breakout) {
            double res = Double.MAX_VALUE, sup = -Double.MAX_VALUE;
            for (int k : pivots(c, true, 3, i - 3)) if (c[k].h > cl[i]) res = Math.min(res, c[k].h);
            for (int k : pivots(c, false, 3, i - 3)) if (c[k].l < cl[i]) sup = Math.max(sup, c[k].l);
            if (res - cl[i] < 0.6 * a) { s -= 1; why.add("near resistance -1"); }
            if (cl[i] - sup < 0.6 * a) { s += 1; why.add("near support +1"); }
        }

        // double top / double bottom
        List<Integer> ph = pivots(c, true, 3, i - 3), pl = pivots(c, false, 3, i - 3);
        if (ph.size() >= 2) {
            int x = ph.get(ph.size() - 2), y = ph.get(ph.size() - 1);
            if (y - x >= 5 && i - x <= 50 && i - y <= 15 && Math.abs(c[x].h - c[y].h) <= 0.35 * a) {
                double neck = Double.MAX_VALUE;
                for (int k = x; k <= y; k++) neck = Math.min(neck, c[k].l);
                if (cl[i] < neck) { s -= 2; why.add("double top -2"); }
            }
        }
        if (pl.size() >= 2) {
            int x = pl.get(pl.size() - 2), y = pl.get(pl.size() - 1);
            if (y - x >= 5 && i - x <= 50 && i - y <= 15 && Math.abs(c[x].l - c[y].l) <= 0.35 * a) {
                double neck = -Double.MAX_VALUE;
                for (int k = x; k <= y; k++) neck = Math.max(neck, c[k].h);
                if (cl[i] > neck) { s += 2; why.add("double bottom +2"); }
            }
        }

        d.score = s;
        StringBuilder sb = new StringBuilder();
        for (String w : why) { if (sb.length() > 0) sb.append(", "); sb.append(w); }
        d.why = sb.toString();

        int thr = p.threshold;
        if (s > 0 && dn) thr++;   // counter-trend needs more proof
        if (s < 0 && up) thr++;
        String act = "WAIT";
        if (s >= thr) act = "BUY"; else if (-s >= thr) act = "SELL";
        if (act.equals("BUY") && r > 78) { act = "WAIT"; d.why += " | rsi too hot"; }
        if (act.equals("SELL") && r < 22) { act = "WAIT"; d.why += " | rsi too cold"; }
        d.action = act;

        if (!act.equals("WAIT")) {
            boolean buy = act.equals("BUY");
            double ext = buy ? Double.MAX_VALUE : -Double.MAX_VALUE;
            for (int k = Math.max(0, i - (p.scalp ? 3 : 7)); k <= i; k++) ext = buy ? Math.min(ext, c[k].l) : Math.max(ext, c[k].h);
            double dist = buy ? forming - ext + 0.15 * a : ext - forming + 0.15 * a;
            dist = Math.min(Math.max(dist, p.slAtr * a), (p.scalp ? 2.0 : 3.5) * a);
            d.entry = forming;
            d.sl = buy ? forming - dist : forming + dist;
            d.tp = buy ? forming + p.rr * dist : forming - p.rr * dist;
            d.key = act + ":" + String.format(Locale.US, "%." + Math.max(decimals, 0) + "f", cl[i]);
        }
        return d;
    }

    static List<Integer> pivots(Candle[] c, boolean highs, int k, int upto) {
        List<Integer> out = new ArrayList<>();
        for (int i = k; i <= upto && i < c.length - k; i++) {
            boolean ok = true;
            for (int j = 1; j <= k && ok; j++) {
                if (highs) ok = c[i].h >= c[i - j].h && c[i].h > c[i + j].h;
                else ok = c[i].l <= c[i - j].l && c[i].l < c[i + j].l;
            }
            if (ok) out.add(i);
        }
        return out;
    }

    static int pattern(Candle[] c, int i, double a, String[] name) {
        Candle x = c[i], y = c[i - 1], z = c[i - 2];
        if (y.c < y.o && x.c > x.o && x.c >= y.o && x.o <= y.c && x.body() > y.body() && x.body() > 0.5 * a) { name[0] = "bull engulfing"; return 2; }
        if (y.c > y.o && x.c < x.o && x.c <= y.o && x.o >= y.c && x.body() > y.body() && x.body() > 0.5 * a) { name[0] = "bear engulfing"; return -2; }
        if (z.c < z.o && z.body() > 0.6 * a && y.body() < 0.35 * z.body() && x.c > x.o && x.c > (z.o + z.c) / 2) { name[0] = "morning star"; return 2; }
        if (z.c > z.o && z.body() > 0.6 * a && y.body() < 0.35 * z.body() && x.c < x.o && x.c < (z.o + z.c) / 2) { name[0] = "evening star"; return -2; }
        if (x.range() > 0.8 * a && x.lower() >= 2 * x.body() && x.upper() <= 0.35 * x.range() && c[i - 5].c > x.c) { name[0] = "hammer"; return 2; }
        if (x.range() > 0.8 * a && x.upper() >= 2 * x.body() && x.lower() <= 0.35 * x.range() && c[i - 5].c < x.c) { name[0] = "shooting star"; return -2; }
        return 0;
    }
}
