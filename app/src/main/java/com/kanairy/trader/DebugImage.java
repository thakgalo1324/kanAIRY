package com.kanairy.trader;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import com.kanairy.trader.engine.ChartReader;
import com.kanairy.trader.engine.PriceScale;
import java.util.List;
import java.util.Locale;

/** Annotated screenshot so margins and colours can be checked in the gallery. */
final class DebugImage {
    private DebugImage() {}

    static Bitmap draw(KanairyService.Shot s, int x0, int y0, int x1, int y1, int axisLeft,
                       ChartReader.Result r, List<double[]> labels, PriceScale sc, String summary) {
        Bitmap m = s.bmp.copy(Bitmap.Config.ARGB_8888, true);
        Canvas c = new Canvas(m);
        Paint p = new Paint();
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(3);
        p.setColor(Color.YELLOW);
        c.drawRect(x0, y0, x1, y1, p);
        p.setColor(Color.CYAN);
        c.drawRect(axisLeft, y0, s.w - 1, y1, p);
        p.setStrokeWidth(1);
        p.setColor(Color.MAGENTA);
        if (r != null) for (ChartReader.Px k : r.candles)
            c.drawRect(k.x - k.width / 2f - 1, k.yHigh, k.x + k.width / 2f + 1, k.yLow, p);
        Paint t = new Paint();
        t.setTextSize(26);
        t.setColor(Color.CYAN);
        if (labels != null) for (double[] l : labels)
            c.drawText(String.format(Locale.US, "%s", l[1]), axisLeft, (float) l[0], t);
        t.setColor(Color.YELLOW);
        c.drawText(summary + (sc == null ? " | NO SCALE" : " | scale pts " + sc.points), 10, 40, t);
        return m;
    }
}
