package com.kanairy.trader.engine;

import java.util.ArrayList;
import java.util.List;

/** Linear map between screen y and price, fitted from OCR'd price-axis labels. */
public final class PriceScale {
    public final double slope, intercept;
    public final int decimals, points;

    private PriceScale(double slope, double intercept, int decimals, int points) {
        this.slope = slope; this.intercept = intercept; this.decimals = decimals; this.points = points;
    }

    public double price(double y) { return slope * y + intercept; }
    public double y(double price) { return (price - intercept) / slope; }

    /** pts: {y, price, decimals}. Returns null when no trustworthy fit exists. */
    public static PriceScale fit(List<double[]> pts) {
        int n = pts.size();
        if (n < 3) return null;
        final double tolY = 7.0;
        List<Integer> best = null;
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                double y1 = pts.get(i)[0], y2 = pts.get(j)[0];
                double p1 = pts.get(i)[1], p2 = pts.get(j)[1];
                if (Math.abs(y1 - y2) < 12 || p1 == p2) continue;
                double s = (p2 - p1) / (y2 - y1);
                if (s >= 0) continue; // price must fall as y grows
                double b = p1 - s * y1;
                List<Integer> in = new ArrayList<>();
                for (int k = 0; k < n; k++) {
                    double yy = (pts.get(k)[1] - b) / s;
                    if (Math.abs(yy - pts.get(k)[0]) <= tolY) in.add(k);
                }
                if (best == null || in.size() > best.size()) best = in;
            }
        }
        if (best == null || best.size() < 3) return null;
        double sy = 0, sp = 0, syy = 0, syp = 0; int m = best.size(); int dec = 0;
        for (int k : best) {
            double y = pts.get(k)[0], p = pts.get(k)[1];
            sy += y; sp += p; syy += y * y; syp += y * p;
            dec = Math.max(dec, (int) pts.get(k)[2]);
        }
        double den = m * syy - sy * sy;
        if (Math.abs(den) < 1e-9) return null;
        double slope = (m * syp - sy * sp) / den;
        if (slope >= 0) return null;
        double intercept = (sp - slope * sy) / m;
        return new PriceScale(slope, intercept, dec, m);
    }
}
