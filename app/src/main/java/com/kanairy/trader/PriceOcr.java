package com.kanairy.trader;

import android.graphics.Bitmap;
import android.graphics.Rect;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import com.kanairy.trader.engine.PriceScale;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** On-device text reading (ML Kit, bundled model, no network). Used for the price axis and for finding MT5 buttons. */
public final class PriceOcr {
    private PriceOcr() {}
    private static final Pattern NUM = Pattern.compile("\\d[\\d.,]*\\d");

    public static final class Line {
        public final String text;
        public final Rect r;
        Line(String t, Rect r) { text = t; this.r = r; }
    }

    public static final class Result {
        public List<double[]> labels = new ArrayList<>(); // {y, price, decimals, left, right}
        public PriceScale scale;
        public String variant = "";
    }

    private static List<Line> run(Bitmap img, float scale, int offX, int offY) {
        List<Line> out = new ArrayList<>();
        TextRecognizer rec = null;
        try {
            rec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            Text t = Tasks.await(rec.process(InputImage.fromBitmap(img, 0)), 12, TimeUnit.SECONDS);
            for (Text.TextBlock b : t.getTextBlocks()) {
                for (Text.Line ln : b.getLines()) {
                    Rect r = ln.getBoundingBox();
                    if (r == null) continue;
                    out.add(new Line(ln.getText(), new Rect(offX + Math.round(r.left / scale), offY + Math.round(r.top / scale),
                            offX + Math.round(r.right / scale), offY + Math.round(r.bottom / scale))));
                }
            }
        } catch (Exception e) {
            Flog.i("ocr failed: " + e.getMessage());
        } finally {
            if (rec != null) rec.close();
        }
        return out;
    }

    /** Every text line on screen with its position. */
    public static List<Line> lines(Bitmap full, boolean enhance) {
        if (enhance) {
            Bitmap e = Imaging.enhance(full, 1.5f, false);
            List<Line> l = run(e, 1.5f, 0, 0);
            e.recycle();
            if (!l.isEmpty()) return l;
        }
        return run(full, 1f, 0, 0);
    }

    /** Reads the price axis. Tries several image variants and keeps the one whose labels fit a straight price scale best. */
    public static Result readAxis(Bitmap full, int left, int top, int w, int h, boolean enhance) {
        Result best = new Result();
        Bitmap crop;
        try { crop = Bitmap.createBitmap(full, left, top, w, h); } catch (Exception e) { return best; }
        float[] scales = enhance ? new float[]{3f, 3f, 2f} : new float[]{2f};
        boolean[] inv = enhance ? new boolean[]{false, true, false} : new boolean[]{false};
        for (int v = 0; v < scales.length; v++) {
            Bitmap img;
            float sc;
            if (!enhance || v == 2) { sc = 2f; img = Bitmap.createScaledBitmap(crop, (int) (w * 2f), (int) (h * 2f), true); }
            else { sc = scales[v]; img = Imaging.enhance(crop, sc, inv[v]); }
            List<Line> ls = run(img, sc, left, top);
            img.recycle();
            List<double[]> labels = new ArrayList<>();
            for (Line l : ls) {
                double[] p = parse(l.text);
                if (p != null) labels.add(new double[]{(l.r.top + l.r.bottom) / 2.0, p[0], p[1], l.r.left, l.r.right});
            }
            PriceScale ps = PriceScale.fit(labels);
            int pts = ps == null ? 0 : ps.points;
            int bestPts = best.scale == null ? 0 : best.scale.points;
            if (ps != null && (pts > bestPts || best.scale == null)) {
                best.labels = labels; best.scale = ps; best.variant = enhance ? (v == 0 ? "sharp" : v == 1 ? "inverted" : "plain") : "plain";
                if (pts >= 5) break;
            } else if (best.scale == null && labels.size() > best.labels.size()) {
                best.labels = labels;
            }
        }
        crop.recycle();
        return best;
    }

    static double[] parse(String raw) {
        String s = raw.replace('O', '0').replace('o', '0').replace(" ", "");
        Matcher m = NUM.matcher(s);
        if (!m.find()) return null;
        String t = m.group();
        boolean dot = t.contains("."), com = t.contains(",");
        if (dot && com) t = t.replace(",", "");
        else if (com) t = t.replace(',', '.');
        int dec = t.contains(".") ? t.length() - t.lastIndexOf('.') - 1 : 0;
        try { return new double[]{Double.parseDouble(t), dec}; } catch (Exception e) { return null; }
    }
}
