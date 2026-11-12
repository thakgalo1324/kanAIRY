package com.kanairy.trader;

import android.graphics.Bitmap;
import com.kanairy.trader.engine.Candle;
import com.kanairy.trader.engine.ChartReader;
import com.kanairy.trader.engine.PriceScale;
import com.kanairy.trader.engine.Strategy;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/** Observe, analyse, decide, execute, manage. Runs on its own thread inside the service. */
final class Bot {
    private final KanairyService svc;
    private final Mt5Driver drv;
    private final LabEngine lab;
    private Overlay ov;
    private volatile boolean running, auto, scanNow, debugNow, dumpNow;
    private Thread th;
    private long lastScan, lastTradeMs, lastFg, lastFail, lastHeader, openSince;
    private volatile boolean mt5Front;
    private volatile String pendingCmd;
    private volatile String sProblem = "";
    private final List<Long> opened = new ArrayList<>();
    private String lastKey = "";
    private int dayCount, zoomTries, openDir;
    private String day = "";

    // published to the UI
    private volatile String sAction = "WAIT", sInfo = "", sSymbol = "", sTf = "", sPrice = "", sStrategy = "";
    private volatile int sCandles, sOpen;

    // kept for the DEBUG button
    private KanairyService.Shot lastShot;
    private ChartReader.Result lastRead;
    private List<double[]> lastLabels;
    private PriceScale lastScale;
    private int[] lastRegion = new int[5];
    private String lastSummary = "";

    Bot(KanairyService svc, LabEngine lab) {
        this.svc = svc;
        this.lab = lab;
        this.drv = new Mt5Driver(svc);
    }

    void attach(Overlay o) { ov = o; }

    boolean isAuto() { return auto; }

    void setAuto(boolean on) {
        auto = on;
        if (on) { lastScan = 0; Flog.i(Cfg.b(svc, Cfg.DRY, true) ? "AUTO on (paper: no orders)" : "AUTO on (LIVE orders)"); }
        else Flog.i("AUTO off");
        if (ov != null) ov.refresh();
    }

    void requestScan() { scanNow = true; }
    void manual(String cmd) { pendingCmd = cmd; }
    void requestDebug() { debugNow = true; }
    void requestDump() { dumpNow = true; }

    void fill(JSONObject o) throws JSONException {
        o.put("auto", auto).put("action", sAction).put("info", sInfo).put("symbol", sSymbol).put("tf", sTf).put("price", sPrice)
                .put("candles", sCandles).put("strategy", sStrategy).put("mt5", mt5Front).put("open", sOpen).put("today", dayCount)
                .put("problem", sProblem).put("dry", Cfg.b(svc, Cfg.DRY, true)).put("scalp", Cfg.b(svc, Cfg.SCALP, false)).put("mode", Cfg.s(svc, Cfg.MODE, "lab"));
    }

    void start() {
        if (running) return;
        running = true;
        th = new Thread(this::loop, "kanairy-bot");
        th.start();
    }

    void stop() { running = false; auto = false; if (th != null) th.interrupt(); }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    private void loop() {
        while (running) {
            try {
                long now = System.currentTimeMillis();
                if (now - lastFg > 2000) { lastFg = now; mt5Front = drv.foreground(); }
                String cmd = pendingCmd;
                if (cmd != null) { pendingCmd = null; runManual(cmd); }
                if (dumpNow) { dumpNow = false; doDump(); }
                if (debugNow) { debugNow = false; doDebug(); }
                long every = Math.max(4, Cfg.i(svc, Cfg.INTERVAL, 20)) * 1000L;
                boolean timer = auto && now - lastScan >= every;
                if (scanNow || timer) {
                    scanNow = false;
                    lastScan = System.currentTimeMillis();
                    cycle();
                }
                Thread.sleep(300);
            } catch (InterruptedException e) {
                return;
            } catch (Throwable t) {
                Flog.i("error: " + t.getClass().getSimpleName() + " " + t.getMessage());
                ov.setHidden(false);
                sleep(2000);
            }
        }
    }

    private String stamp() { return new SimpleDateFormat("HHmmss", Locale.US).format(new Date()); }

    private void doDump() {
        ov.setHidden(true); sleep(150);
        String d = drv.dump();
        ov.setHidden(false);
        String name = "ui_dump_" + stamp() + ".txt";
        Flog.i(Files.saveText(svc, name, d) ? "UI dump saved: Downloads/Kanairy/" + name : "UI dump failed");
    }

    private void doDebug() {
        if (lastShot == null) { Flog.i("run SCAN first"); return; }
        Bitmap m = DebugImage.draw(lastShot, lastRegion[0], lastRegion[1], lastRegion[2], lastRegion[3], lastRegion[4], lastRead, lastLabels, lastScale, lastSummary);
        String name = "kanairy_debug_" + stamp() + ".png";
        Flog.i(Files.savePng(svc, name, m) ? "debug image saved: Pictures/Kanairy" : "debug save failed");
    }

    /** After a failed order step, save a dump and screenshot (at most one set per 2 minutes) so the cause is visible. */
    private void failDiagnostics(String why) {
        if (System.currentTimeMillis() - lastFail < 120000) return;
        lastFail = System.currentTimeMillis();
        try {
            KanairyService.Shot s = svc.screenshot();
            if (s != null) Files.savePng(svc, "kanairy_fail_" + stamp() + ".png", s.bmp);
            Files.saveText(svc, "kanairy_fail_" + stamp() + ".txt", why + "\n\n" + drv.dump());
            Flog.i("saved failure report to Downloads/Kanairy and Pictures/Kanairy");
        } catch (Throwable ignored) { }
    }

    // ---------- reading the screen ----------

    private static final class Scan {
        ChartReader.Result r;
        PriceOcr.Result o;
        int[] region;
        String error;
    }

    private Scan read(KanairyService.Shot s) {
        Scan sc = new Scan();
        int w = s.w, h = s.h;
        boolean enh = Cfg.b(svc, Cfg.ENHANCE, true);
        int sx = (int) (w * 0.70), sy = (int) (h * 0.05), sh = (int) (h * 0.90);
        sc.o = PriceOcr.readAxis(s.bmp, sx, sy, w - sx, sh, enh);
        lastLabels = sc.o.labels; lastScale = sc.o.scale;
        if (sc.o.scale == null) { sc.error = "price axis unreadable (" + sc.o.labels.size() + " labels)"; return sc; }

        int x0 = w * Cfg.i(svc, Cfg.M_LEFT, 0) / 100, x1 = w - w * Cfg.i(svc, Cfg.M_RIGHT, 13) / 100;
        int y0 = h * Cfg.i(svc, Cfg.M_TOP, 14) / 100, y1 = h - h * Cfg.i(svc, Cfg.M_BOT, 13) / 100;
        if (Cfg.b(svc, Cfg.AUTO_REGION, true)) {
            double minLeft = Double.MAX_VALUE, minY = Double.MAX_VALUE, maxY = -Double.MAX_VALUE;
            List<Double> ys = new ArrayList<>();
            for (double[] l : sc.o.labels) {
                double yy = sc.o.scale.y(l[1]);
                if (Math.abs(yy - l[0]) > 8) continue; // not on the fitted line
                minLeft = Math.min(minLeft, l[3]); minY = Math.min(minY, l[0]); maxY = Math.max(maxY, l[0]); ys.add(l[0]);
            }
            if (ys.size() >= 3) {
                double step = (maxY - minY) / (ys.size() - 1);
                x1 = (int) Math.max(w * 0.55, minLeft - 6);
                y0 = (int) Math.max(h * 0.05, minY - step * 0.6);
                y1 = (int) Math.min(h * 0.95, maxY + step * 0.6);
                x0 = 0;
            }
        }
        sc.region = new int[]{x0, y0, x1, y1, x1};
        lastRegion = sc.region;
        sc.r = ChartReader.read(s.px, w, h, x0, y0, x1, y1, Cfg.i(svc, Cfg.COLOR, 0));
        lastRead = sc.r;
        lastSummary = sc.r.candles.size() + " candles " + sc.r.colors + " axis:" + sc.o.variant;
        return sc;
    }

    private static final Pattern HEAD = Pattern.compile("([A-Z][A-Z0-9._#]{2,11})\\s*[,.]?\\s*(M1|M5|M15|M30|H1|H4|D1|W1|MN)\\b");

    private void readHeader(KanairyService.Shot s) {
        if (System.currentTimeMillis() - lastHeader < 60000 && !sSymbol.isEmpty()) return;
        lastHeader = System.currentTimeMillis();
        try {
            int hh = (int) (s.h * 0.16);
            Bitmap top = Bitmap.createBitmap(s.bmp, 0, 0, s.w, hh);
            for (PriceOcr.Line l : PriceOcr.lines(top, Cfg.b(svc, Cfg.ENHANCE, true))) {
                Matcher m = HEAD.matcher(l.text.replace(" ", "").toUpperCase(Locale.US));
                if (m.find()) { sSymbol = m.group(1); sTf = m.group(2); drv.setSymbol(sSymbol); return; }
            }
        } catch (Exception ignored) { }
    }

    private boolean needsZoom(Scan sc) {
        if (!Cfg.b(svc, Cfg.AUTO_ZOOM, true) || sc.r == null) return false;
        int n = sc.r.candles.size();
        return n < 45 || n > 170 || sc.r.medianWidth < 3;
    }

    private void zoom(Scan sc, KanairyService.Shot s) {
        int n = sc.r.candles.size();
        boolean zoomIn = n > 170 || sc.r.medianWidth < 3;   // too many or too thin: show fewer, fatter candles
        float cx = (sc.region[0] + sc.region[2]) / 2f, cy = (sc.region[1] + sc.region[3]) / 2f;
        float small = s.w * 0.10f, big = s.w * 0.26f;
        svc.pinch(cx, cy, zoomIn ? small : big, zoomIn ? big : small, 350);
        zoomTries++;
        sleep(900);
    }

    private static boolean blank(int[] px) {
        for (int v : px) {
            int r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
            if (Math.max(r, Math.max(g, b)) > 40) return false;
        }
        return true;
    }

    private void publish(String action, String info) {
        sAction = action; sInfo = info;
        ov.setSignal(action, info);
    }

    // ---------- analysis shared by auto mode and manual orders ----------

    private static final class An {
        Scan sc;
        List<Candle> cs;
        PriceScale scale;
        Strategy.Decision built;
        double forming;
        int count;
        String err;
    }

    private void problem(String m) { sProblem = m; Flog.i(m); }

    private An analyse(boolean allowZoom) {
        An a = new An();
        if (!drv.foreground()) { a.err = "MT5 is not in front. Open MT5 on a chart."; return a; }
        Scan sc = null;
        KanairyService.Shot s = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            ov.setHidden(true);
            sleep(180);
            s = svc.screenshot();
            ov.setHidden(false);
            if (s == null) { a.err = "Screenshot failed. Is Kanairy still enabled in Accessibility?"; return a; }
            lastShot = s;
            if (blank(s.px)) { a.err = "Black frame: MT5 blocks screenshots on this screen."; return a; }
            sc = read(s);
            if (sc.error != null) { a.err = "Cannot read the chart: " + sc.error + ". Press Debug image."; return a; }
            if (allowZoom && needsZoom(sc) && zoomTries < 8) {
                Flog.i("auto-zoom: " + sc.r.candles.size() + " candles, width " + sc.r.medianWidth + "px");
                ov.setHidden(true);
                zoom(sc, s);
                ov.setHidden(false);
                continue;
            }
            break;
        }
        if (sc == null || sc.r == null) { a.err = "Cannot read the chart."; return a; }
        if (!needsZoom(sc)) zoomTries = 0;
        readHeader(s);
        a.count = sc.r.candles.size();
        sCandles = a.count;
        if (a.count < 41) { a.err = "Saw only " + a.count + " candles. Use a candlestick chart and check candle colours in Settings."; return a; }
        if (sc.r.medianWidth < 3) { a.err = "Candles are too thin. Zoom the chart in a little."; return a; }
        a.sc = sc;
        a.scale = sc.o.scale;
        a.cs = ChartReader.toPrices(sc.r.candles, a.scale);
        a.forming = a.cs.get(a.cs.size() - 1).c;
        sPrice = fmt(a.forming, a.scale.decimals);
        Strategy.Params p = new Strategy.Params();
        p.threshold = Cfg.i(svc, Cfg.THR, 3);
        p.slAtr = Cfg.d(svc, Cfg.SL_ATR, 1.5);
        p.rr = Cfg.d(svc, Cfg.RR, 2.0);
        p.scalp = Cfg.b(svc, Cfg.SCALP, false);
        a.built = Strategy.decide(a.cs, p, a.scale.decimals);
        return a;
    }

    // ---------- one full automatic cycle ----------

    private void cycle() {
        An a = analyse(true);
        if (a.err != null) { publish("WAIT", a.err); sProblem = a.err; Flog.i(a.err); return; }
        sProblem = "";
        PriceScale scale = a.scale;
        List<Candle> cs = a.cs;
        Strategy.Decision built = a.built;
        double forming = a.forming;
        int count = a.count;

        String mode = Cfg.s(svc, Cfg.MODE, "lab");
        String stratJson = Cfg.s(svc, Cfg.STRAT, "");
        boolean haveLab = !stratJson.isEmpty();
        JSONObject lr = null;
        sStrategy = "";
        if (haveLab && !mode.equals("builtin")) {
            try { sStrategy = new JSONObject(stratJson).optString("name", ""); } catch (JSONException ignored) { }
            lr = runLab(cs, stratJson);
        }

        String action = "WAIT", info;
        double sl = Double.NaN, tp = Double.NaN, lot = Cfg.d(svc, Cfg.LOT, 0.01);
        boolean exitLong = false, exitShort = false;
        String key = built.key;
        if (mode.equals("builtin") || !haveLab) {
            action = built.action; sl = built.sl; tp = built.tp;
            info = "built-in score " + built.score + "  rsi " + Math.round(built.rsi) + "\n" + built.why + (haveLab || !mode.equals("lab") ? "" : "\nNo lab strategy active: using built-in");
        } else if (lr == null) {
            info = "strategy engine not ready or failed";
        } else if (lr.has("error")) {
            info = "strategy error: " + lr.optString("error");
        } else {
            boolean el = lr.optBoolean("enterLong"), es = lr.optBoolean("enterShort");
            exitLong = lr.optBoolean("exitLong"); exitShort = lr.optBoolean("exitShort");
            String labAct = el && !es ? "BUY" : es && !el ? "SELL" : "WAIT";
            action = mode.equals("both") ? (labAct.equals(built.action) ? labAct : "WAIT") : labAct;
            double atr = lr.optDouble("atr", Double.NaN), slA = lr.optDouble("slAtr", Double.NaN), tpA = lr.optDouble("tpAtr", Double.NaN);
            boolean buy = action.equals("BUY");
            if (!action.equals("WAIT")) {
                double entry = forming;
                if (!Double.isNaN(atr) && !Double.isNaN(slA)) sl = buy ? entry - atr * slA : entry + atr * slA;
                else sl = built.sl != 0 ? built.sl : (buy ? entry - 2 * built.atr : entry + 2 * built.atr);
                if (!Double.isNaN(atr) && !Double.isNaN(tpA)) tp = buy ? entry + atr * tpA : entry - atr * tpA;
                double lots = lr.optDouble("lots", 0);
                if (lots > 0) lot = lots;
                key = action + ":" + fmt(cs.get(cs.size() - 2).c, scale.decimals);
            }
            info = sStrategy + ": " + (el ? "long rule met" : es ? "short rule met" : "no entry") + (el && es ? " (conflict)" : "")
                    + "\nbuilt-in score " + built.score + (mode.equals("both") ? " (must agree)" : "");
        }
        if (!action.equals("WAIT") && !Double.isNaN(sl))
            info += "\nSL " + fmt(sl, scale.decimals) + (Double.isNaN(tp) ? "" : "  TP " + fmt(tp, scale.decimals));
        publish(action, info);
        Flog.i(action + " (" + count + " candles, " + a.sc.o.variant + " axis)");

        if (!auto) return;
        boolean live = !Cfg.b(svc, Cfg.DRY, true);
        if (live) timeStop();
        if (live && ((exitLong && openDir == 1) || (exitShort && openDir == -1))) {
            Flog.i("exit rule met");
            closeNow("Exit rule");
            return;
        }
        if (action.equals("WAIT")) return;
        trade(action, key, lot, sl, tp, scale.decimals);
    }

    // ---------- manual hands ----------

    private void runManual(String cmd) {
        try {
            if (cmd.equals("close")) { closeNow("Manual close"); return; }
            if (cmd.equals("stop")) { setAuto(false); closeNow("Stop everything"); return; }
            boolean buy = cmd.equals("buy");
            Flog.i("hands: manual " + cmd.toUpperCase());
            if (!drv.foreground()) { problem("MT5 is not in front. Open MT5 first."); return; }
            An a = analyse(false);
            double lot = Cfg.d(svc, Cfg.LOT, 0.01), sl = Double.NaN, tp = Double.NaN;
            int dec = 5;
            if (a.err == null) {
                dec = a.scale.decimals;
                double atr = a.built.atr;
                if (atr > 0) {
                    double dist = Cfg.d(svc, Cfg.SL_ATR, 1.5) * atr, rr = Cfg.d(svc, Cfg.RR, 2.0);
                    sl = buy ? a.forming - dist : a.forming + dist;
                    tp = buy ? a.forming + rr * dist : a.forming - rr * dist;
                }
            } else {
                Flog.i("chart not readable, sending the order without SL and TP");
            }
            execute(buy, lot, sl, tp, dec, "Manual");
        } catch (Throwable t) {
            problem("Manual command failed: " + t.getClass().getSimpleName());
        }
    }

    /** Runs the order through MT5 and records the outcome. */
    private boolean execute(boolean buy, double lot, double sl, double tp, int dec, String why) {
        String action = buy ? "BUY" : "SELL";
        ov.setHidden(true);
        String res = drv.openTrade(buy, lot, sl, tp, dec);
        if (res.startsWith("FAIL")) failDiagnostics(res);
        ov.setHidden(false);
        Flog.i(res);
        boolean ok = res.startsWith("OK");
        Events.add(svc, ok ? action : "ERROR", why + ": " + res);
        if (ok) {
            sProblem = "";
            opened.add(System.currentTimeMillis());
            lastTradeMs = System.currentTimeMillis();
            openDir = buy ? 1 : -1;
            if (openSince == 0) openSince = System.currentTimeMillis();
            String today = new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date());
            if (!today.equals(day)) { day = today; dayCount = 0; }
            dayCount++;
        } else {
            sProblem = res;
        }
        return ok;
    }

    private void closeNow(String why) {
        ov.setHidden(true);
        String res = drv.closeAll();
        ov.setHidden(false);
        Flog.i(why + ": " + res);
        Events.add(svc, "EXIT", why + ": " + res);
        opened.clear();
        openDir = 0; openSince = 0; sOpen = 0;
    }

    private int openCount() {
        long keep = (long) (Cfg.d(svc, Cfg.HOLD_MIN, 0) > 0 ? Cfg.d(svc, Cfg.HOLD_MIN, 0) * 60000L : 3600000L);
        long now = System.currentTimeMillis();
        for (int i = opened.size() - 1; i >= 0; i--) if (now - opened.get(i) > keep) opened.remove(i);
        if (Cfg.b(svc, Cfg.POS_CHECK, true)) {
            ov.setHidden(true);
            int n = drv.readOpenCount();
            ov.setHidden(false);
            if (n >= 0) return n;
            Flog.i("cannot read MT5 positions, using Kanairy's own count");
        }
        return opened.size();
    }

    private JSONObject runLab(List<Candle> cs, String stratJson) {
        StringBuilder sb = new StringBuilder("[");
        int n = cs.size() - 1; // closed candles only
        for (int i = 0; i < n; i++) {
            Candle c = cs.get(i);
            if (i > 0) sb.append(',');
            sb.append(String.format(Locale.US, "{\"t\":%d,\"o\":%.10f,\"h\":%.10f,\"l\":%.10f,\"c\":%.10f,\"v\":0}", i * 60L, c.o, c.h, c.l, c.c));
        }
        sb.append(']');
        String res = lab.eval(sb.toString(), stratJson);
        if (res == null) return null;
        try { return new JSONObject(res); } catch (JSONException e) { return null; }
    }

    // ---------- automatic execution ----------

    private void timeStop() {
        double hold = Cfg.d(svc, Cfg.HOLD_MIN, 0);
        if (hold <= 0 || openSince == 0 || System.currentTimeMillis() - openSince < hold * 60000L) return;
        closeNow("Time stop");
    }

    private static String fmt(double v, int dec) { return String.format(Locale.US, "%." + Math.max(dec, 0) + "f", v); }

    private void trade(String action, String key, double lot, double sl, double tp, int dec) {
        if (key.equals(lastKey)) return;
        boolean buy = action.equals("BUY");
        int dir = buy ? 1 : -1;
        String sym = sSymbol.isEmpty() ? "chart" : sSymbol;

        if (Cfg.b(svc, Cfg.DRY, true)) {
            String m = "PAPER " + action + " " + sym + " " + lot + " sl " + fmt(sl, dec) + (Double.isNaN(tp) ? "" : " tp " + fmt(tp, dec));
            Flog.i(m);
            Events.add(svc, action, m);
            lastKey = key;
            return;
        }

        String today = new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date());
        if (!today.equals(day)) { day = today; dayCount = 0; }
        if (dayCount >= Cfg.i(svc, Cfg.MAX_DAY, 20)) { Flog.i("daily trade cap reached"); return; }

        int open = openCount();
        sOpen = open;
        if (open == 0) { openDir = 0; openSince = 0; }

        if (open > 0 && openDir == -dir) {
            closeNow("Reversal");
            lastKey = key; lastTradeMs = System.currentTimeMillis();
            return;
        }
        if (open >= Cfg.i(svc, Cfg.MAX_OPEN, 1)) { Flog.i("max open trades reached"); return; }
        if (System.currentTimeMillis() - lastTradeMs < (long) (Cfg.d(svc, Cfg.COOLDOWN, 2) * 60000L)) { Flog.i("cooldown"); return; }

        lastKey = key;
        if (execute(buy, lot, sl, tp, dec, "Auto")) sOpen = open + 1;
    }
}
