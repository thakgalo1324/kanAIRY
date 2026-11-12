package com.kanairy.trader;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Drives the MT5 Android UI. Every step tries the accessibility tree first, then reads the
 * screen with OCR and taps by position, so it keeps working when MT5 hides names on its buttons.
 */
final class Mt5Driver {
    static final String PKG = "net.metaquotes.metatrader5";
    private final KanairyService svc;
    private volatile String symbol;

    Mt5Driver(KanairyService svc) { this.svc = svc; }

    void setSymbol(String s) { symbol = s; }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    private int screenH() { return svc.screen().height(); }
    private int screenW() { return svc.screen().width(); }

    // ---------- tree helpers ----------

    boolean foreground() {
        AccessibilityNodeInfo r = svc.getRootInActiveWindow();
        if (r == null || r.getPackageName() == null) return false;
        return PKG.equals(r.getPackageName().toString());
    }

    private List<AccessibilityNodeInfo> all() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        AccessibilityNodeInfo r = svc.getRootInActiveWindow();
        if (r != null) walk(r, out, 0);
        return out;
    }

    private void walk(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out, int depth) {
        if (n == null || depth > 40) return;
        out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), out, depth + 1);
    }

    private static String label(AccessibilityNodeInfo n) {
        CharSequence t = n.getText();
        if (t != null && t.length() > 0) return t.toString().trim();
        CharSequence d = n.getContentDescription();
        return d == null ? "" : d.toString().trim();
    }

    private static Rect bounds(AccessibilityNodeInfo n) {
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        return b;
    }

    private AccessibilityNodeInfo find(Predicate<AccessibilityNodeInfo> p) {
        for (AccessibilityNodeInfo n : all()) if (p.test(n)) return n;
        return null;
    }

    private boolean click(AccessibilityNodeInfo n) {
        if (n == null) return false;
        AccessibilityNodeInfo c = n;
        for (int g = 0; c != null && !c.isClickable() && g < 6; g++) c = c.getParent();
        if (c != null && c.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        Rect b = bounds(n);
        return svc.tap(b.exactCenterX(), b.exactCenterY());
    }

    private void back() { svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK); }

    // ---------- unified targets: node first, OCR second ----------

    private static final class Target {
        AccessibilityNodeInfo node;
        Rect r;
        String text;
    }

    private boolean tap(Target t) {
        if (t == null) return false;
        if (t.node != null && click(t.node)) return true;
        return svc.tap(t.r.exactCenterX(), t.r.exactCenterY());
    }

    /** Matching targets sorted top to bottom. */
    private List<Target> targets(String regex, boolean ocr) {
        Pattern p = Pattern.compile(regex, Pattern.CASE_INSENSITIVE);
        List<Target> out = new ArrayList<>();
        for (AccessibilityNodeInfo n : all()) {
            String l = label(n);
            if (l.isEmpty() || !p.matcher(l).find()) continue;
            Target t = new Target();
            t.node = n; t.r = bounds(n); t.text = l;
            out.add(t);
        }
        if (out.isEmpty() && ocr) {
            KanairyService.Shot s = svc.screenshot();
            if (s != null) {
                for (PriceOcr.Line ln : PriceOcr.lines(s.bmp, Cfg.b(svc, Cfg.ENHANCE, true))) {
                    if (!p.matcher(ln.text).find()) continue;
                    Target t = new Target();
                    t.r = ln.r; t.text = ln.text;
                    out.add(t);
                }
            }
        }
        out.sort((a, b) -> Integer.compare(a.r.top, b.r.top));
        return out;
    }

    private Target first(String regex) { List<Target> l = targets(regex, true); return l.isEmpty() ? null : l.get(0); }
    private Target lowest(String regex) { List<Target> l = targets(regex, true); return l.isEmpty() ? null : l.get(l.size() - 1); }

    private boolean has(String regex) { return !targets(regex, false).isEmpty(); }

    private boolean tapTab(String name) {
        Pattern p = Pattern.compile("^" + Pattern.quote(name) + "$", Pattern.CASE_INSENSITIVE);
        int limit = (int) (screenH() * 0.8);
        for (Target t : targets("^" + Pattern.quote(name) + "$", true)) {
            if (t.r.centerY() > limit && p.matcher(t.text.trim()).find()) return tap(t);
        }
        return false;
    }

    // ---------- order screen ----------

    private boolean isOrderScreen() {
        if (has("stop loss|s/l") && has("take profit|t/p")) return true;
        return !targets("stop loss", true).isEmpty() && !targets("take profit", true).isEmpty();
    }

    private boolean tryOpen(Runnable attempt) {
        attempt.run();
        sleep(1300);
        return isOrderScreen();
    }

    /** Opens MT5's ticket. Tries the labelled button, taught position, id guesses, then the Quotes menu. */
    private String openOrderScreen() {
        if (isOrderScreen()) return null;
        // 1 labelled node
        AccessibilityNodeInfo n = find(x -> Pattern.compile("new.?order|new.?trade", Pattern.CASE_INSENSITIVE).matcher(label(x)).find()
                || (x.getViewIdResourceName() != null && x.getViewIdResourceName().toLowerCase(Locale.US).matches(".*(new_?order|neworder|new_?trade).*")));
        if (n != null && tryOpen(() -> click(n))) return null;
        // 2 taught position
        double fx = Cfg.d(svc, Cfg.NO_X, 0), fy = Cfg.d(svc, Cfg.NO_Y, 0);
        if (fx > 0 && fy > 0 && tryOpen(() -> svc.tap((float) (screenW() * fx / 100.0), (float) (screenH() * fy / 100.0)))) return null;
        // 3 toolbar guess by id or description
        AccessibilityNodeInfo g = find(x -> {
            String id = x.getViewIdResourceName() == null ? "" : x.getViewIdResourceName().toLowerCase(Locale.US);
            String d = label(x).toLowerCase(Locale.US);
            return bounds(x).centerY() < screenH() * 0.25 && (id.contains("trade") || id.contains("order") || d.equals("trade") || d.equals("order"));
        });
        if (g != null && tryOpen(() -> click(g))) return null;
        // 4 Quotes tab, tap the symbol, choose New order
        String sym = symbol;
        if (sym != null) {
            boolean ok = tryOpen(() -> {
                tapTab("Quotes");
                sleep(900);
                Target row = first("^" + Pattern.quote(sym) + "\\b");
                if (row == null) return;
                tap(row);
                sleep(900);
                Target m = first("new order|^trade$|new trade");
                if (m != null) tap(m);
            });
            if (ok) return null;
        }
        return "cannot open the order ticket: press TEACH on Home and tap the New Order button once";
    }

    private String fieldLabel(AccessibilityNodeInfo n) {
        StringBuilder sb = new StringBuilder();
        if (n.getHintText() != null) sb.append(n.getHintText()).append(' ');
        if (n.getContentDescription() != null) sb.append(n.getContentDescription()).append(' ');
        AccessibilityNodeInfo par = n.getParent();
        if (par != null) {
            int idx = -1;
            for (int i = 0; i < par.getChildCount(); i++) {
                AccessibilityNodeInfo ch = par.getChild(i);
                if (ch != null && ch.equals(n)) { idx = i; break; }
            }
            if (idx > 0) {
                AccessibilityNodeInfo prev = par.getChild(idx - 1);
                if (prev != null) sb.append(label(prev)).append(' ');
            }
            if (par.getContentDescription() != null) sb.append(par.getContentDescription());
        }
        return sb.toString().toLowerCase(Locale.US);
    }

    private static String fmt(double v, int dec) { return String.format(Locale.US, "%." + Math.max(dec, 0) + "f", v); }

    private boolean setText(AccessibilityNodeInfo n, String s) {
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s);
        boolean ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
        if (!ok) {
            n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
        }
        n.performAction(AccessibilityNodeInfo.ACTION_CLEAR_FOCUS);
        return ok;
    }

    private static final Pattern ANYNUM = Pattern.compile("-?\\d+(?:[.,]\\d+)?");

    /** True when the field shows our value, or shows something we cannot read as a number (unknown is not a failure). */
    private boolean same(AccessibilityNodeInfo n, double want) {
        try {
            n.refresh();
            String t = n.getText() == null ? "" : n.getText().toString();
            java.util.regex.Matcher m = ANYNUM.matcher(t.replace(" ", ""));
            if (!m.find()) return true;
            double got = Double.parseDouble(m.group().replace(',', '.'));
            return Math.abs(got - want) < Math.max(1e-9, Math.abs(want) * 1e-4);
        } catch (Exception e) { return true; }
    }

    /** Fills one field by finding its label on screen (OCR), tapping beside it, and typing into the focused input. */
    private boolean fillViaOcr(String labelRegex, double value, int dec) {
        Target lt = first(labelRegex);
        if (lt == null) return false;
        float[] xs = {screenW() * 0.72f, screenW() * 0.5f};
        for (float x : xs) {
            svc.tap(x, lt.r.centerY());
            sleep(500);
            AccessibilityNodeInfo root = svc.getRootInActiveWindow();
            AccessibilityNodeInfo f = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (f != null && setText(f, fmt(value, dec)) && same(f, value)) return true;
        }
        return false;
    }

    /** Fills the ticket and presses Buy/Sell. NaN sl or tp skips that field. Returns "OK ..." or "FAIL: reason". */
    String openTrade(boolean buy, double lot, double sl, double tp, int dec) {
        if (!foreground()) return "FAIL: MT5 not in front";
        Flog.i("hands: opening the order ticket");
        String open = openOrderScreen();
        if (open != null) return "FAIL: " + open;
        Flog.i("hands: ticket is open");

        List<AccessibilityNodeInfo> edits = new ArrayList<>();
        for (AccessibilityNodeInfo n : all()) {
            String cn = n.getClassName() == null ? "" : n.getClassName().toString();
            if (n.isEditable() || cn.contains("EditText")) edits.add(n);
        }
        AccessibilityNodeInfo vol = null, slN = null, tpN = null;
        for (AccessibilityNodeInfo n : edits) {
            String l = fieldLabel(n);
            if (vol == null && (l.contains("volume") || l.contains("lot"))) vol = n;
            else if (slN == null && (l.contains("stop loss") || l.contains("s/l"))) slN = n;
            else if (tpN == null && (l.contains("take profit") || l.contains("t/p"))) tpN = n;
        }
        if ((vol == null || slN == null || tpN == null) && edits.size() >= 3) {
            edits.sort((x, y) -> Integer.compare(bounds(x).top, bounds(y).top));
            vol = edits.get(0); slN = edits.get(1); tpN = edits.get(2);
        }

        final boolean hasSl = !Double.isNaN(sl), hasTp = !Double.isNaN(tp);
        boolean filled;
        if (vol != null && (slN != null || !hasSl) && (tpN != null || !hasTp)) {
            filled = setText(vol, fmt(lot, 2)) && (!hasSl || setText(slN, fmt(sl, dec))) && (!hasTp || setText(tpN, fmt(tp, dec)));
            sleep(500);
            filled = filled && same(vol, lot) && (!hasSl || same(slN, sl)) && (!hasTp || same(tpN, tp));
        } else {
            filled = fillViaOcr("^volume|^lot", lot, 2) && (!hasSl || fillViaOcr("stop loss|^s/l", sl, dec))
                    && (!hasTp || fillViaOcr("take profit|^t/p", tp, dec));
        }
        if (filled) Flog.i("hands: volume" + (hasSl ? ", stop loss" : "") + (hasTp ? ", take profit" : "") + " typed");
        if (!filled) { back(); return "FAIL: could not type volume / stop loss / take profit into the ticket"; }

        final String side = buy ? "buy" : "sell";
        Target btn = lowest("^" + side + "\\b(?!.*(limit|stop))");
        if (btn == null) return "FAIL: " + side + " button not found";
        Flog.i("hands: pressing " + side.toUpperCase());
        if (!tap(btn)) return "FAIL: " + side + " tap failed";
        sleep(1800);

        if (has("invalid|rejected|not enough|no money|off quotes|market closed|error")) { back(); return "FAIL: broker reported an error"; }
        if (isOrderScreen()) back();
        sleep(500);
        tapTab("Chart");
        return "OK " + side + " " + fmt(lot, 2) + (hasSl ? " sl " + fmt(sl, dec) : " no sl") + (hasTp ? " tp " + fmt(tp, dec) : "");
    }

    // ---------- positions ----------

    private static final String POS = "^[A-Z0-9._#]+,?\\s+(buy|sell)\\s+[0-9.,]+";

    private List<Target> positionRows() {
        List<Target> rows = new ArrayList<>(), all = targets(POS, true);
        List<Integer> tops = new ArrayList<>();
        for (Target t : all) {
            int k = t.r.top / 8;
            if (tops.contains(k)) continue;
            tops.add(k);
            rows.add(t);
        }
        return rows;
    }

    /** Number of open positions, or -1 if the Trade tab could not be read. */
    int readOpenCount() {
        if (!foreground()) return -1;
        if (!tapTab("Trade")) return -1;
        sleep(1100);
        int n = positionRows().size();
        tapTab("Chart");
        sleep(800);
        return n;
    }

    /** Best effort: closes open positions one by one through the position menu. */
    String closeAll() {
        if (!foreground()) return "MT5 not in front";
        if (!tapTab("Trade")) return "Trade tab not found";
        sleep(1100);
        int closed = 0;
        for (int guard = 0; guard < 6; guard++) {
            List<Target> rows = positionRows();
            if (rows.isEmpty()) break;
            tap(rows.get(0));
            sleep(900);
            Target m = first("^close (position|order).*|^close$");
            if (m == null) { back(); break; }
            tap(m);
            sleep(900);
            Target c = first("^(close|ok|yes|confirm|close position)$");
            if (c != null) tap(c);
            sleep(1500);
            closed++;
        }
        tapTab("Chart");
        sleep(700);
        return "closed " + closed;
    }

    // ---------- diagnostics ----------

    String dump() {
        StringBuilder sb = new StringBuilder();
        AccessibilityNodeInfo r = svc.getRootInActiveWindow();
        if (r == null) return "no active window";
        dumpNode(r, 0, sb);
        KanairyService.Shot s = svc.screenshot();
        if (s != null) {
            sb.append("\n--- OCR lines ---\n");
            for (PriceOcr.Line l : PriceOcr.lines(s.bmp, Cfg.b(svc, Cfg.ENHANCE, true)))
                sb.append(l.text).append("  [").append(l.r.left).append(',').append(l.r.top).append(',').append(l.r.right).append(',').append(l.r.bottom).append("]\n");
        }
        return sb.toString();
    }

    private void dumpNode(AccessibilityNodeInfo n, int d, StringBuilder sb) {
        if (n == null || d > 40) return;
        Rect b = bounds(n);
        String cn = n.getClassName() == null ? "" : n.getClassName().toString();
        cn = cn.substring(cn.lastIndexOf('.') + 1);
        for (int i = 0; i < d; i++) sb.append(' ');
        sb.append(cn);
        if (n.getViewIdResourceName() != null) sb.append(" id=").append(n.getViewIdResourceName());
        if (n.getText() != null) sb.append(" t='").append(n.getText()).append('\'');
        if (n.getContentDescription() != null) sb.append(" d='").append(n.getContentDescription()).append('\'');
        if (n.getHintText() != null) sb.append(" h='").append(n.getHintText()).append('\'');
        if (n.isClickable()) sb.append(" C");
        if (n.isEditable()) sb.append(" E");
        sb.append(" [").append(b.left).append(',').append(b.top).append(',').append(b.right).append(',').append(b.bottom).append("]\n");
        for (int i = 0; i < n.getChildCount(); i++) dumpNode(n.getChild(i), d + 1, sb);
    }
}
