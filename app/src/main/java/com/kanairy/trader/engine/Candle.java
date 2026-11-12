package com.kanairy.trader.engine;

public final class Candle {
    public final double o, h, l, c;
    public final int x;

    public Candle(double o, double h, double l, double c, int x) {
        this.o = o; this.h = h; this.l = l; this.c = c; this.x = x;
    }

    public boolean bull() { return c >= o; }
    public double body() { return Math.abs(c - o); }
    public double range() { return h - l; }
    public double upper() { return h - Math.max(o, c); }
    public double lower() { return Math.min(o, c) - l; }
}
