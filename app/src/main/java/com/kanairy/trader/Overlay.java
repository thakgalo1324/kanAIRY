package com.kanairy.trader;

import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Floating Kanairy panel drawn above MT5 as an accessibility overlay. */
final class Overlay {
    private final KanairyService svc;
    private final Bot bot;
    private final WindowManager wm;
    private final float dp;

    private FrameLayout root;
    private LinearLayout panel;
    private TextView bubble, tvMode, tvSignal, tvInfo, tvLog, btnAuto;
    private WindowManager.LayoutParams lp;
    private boolean shown, hidden;

    Overlay(KanairyService svc, Bot bot) {
        this.svc = svc;
        this.bot = bot;
        this.wm = (WindowManager) svc.getSystemService(android.content.Context.WINDOW_SERVICE);
        this.dp = svc.getResources().getDisplayMetrics().density;
    }

    private int px(int v) { return Math.round(v * dp); }

    private GradientDrawable bg(int color, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(px(radiusDp));
        return g;
    }

    private TextView chip(String t, int color) {
        TextView v = new TextView(svc);
        v.setText(t);
        v.setTextColor(Color.WHITE);
        v.setTextSize(10.5f);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setGravity(Gravity.CENTER);
        v.setPadding(px(6), px(8), px(6), px(8));
        v.setBackground(bg(color, 8));
        return v;
    }

    private LinearLayout rowOf() {
        LinearLayout r = new LinearLayout(svc);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setPadding(0, px(5), 0, 0);
        return r;
    }

    private void addChip(LinearLayout row, TextView c, boolean first) {
        LinearLayout.LayoutParams m = new LinearLayout.LayoutParams(0, -2, 1f);
        if (!first) m.leftMargin = px(5);
        c.setSingleLine(true);
        c.setEllipsize(android.text.TextUtils.TruncateAt.END);
        row.addView(c, m);
    }

    /** Dangerous chips need two taps: the first arms it for 3 seconds. */
    private void confirmChip(TextView chip, String label, Runnable go) {
        final boolean[] armed = new boolean[1];
        chip.setOnClickListener(v -> {
            if (armed[0]) { armed[0] = false; chip.setText(label); go.run(); return; }
            armed[0] = true;
            chip.setText("TAP AGAIN");
            svc.mainHandler().postDelayed(() -> { armed[0] = false; chip.setText(label); }, 3000);
        });
    }

    private void build() {
        root = new FrameLayout(svc);

        panel = new LinearLayout(svc);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(px(10), px(8), px(10), px(10));
        panel.setBackground(bg(0xF010161D, 16));

        LinearLayout head = new LinearLayout(svc);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(svc);
        title.setText("Kanairy");
        title.setTextColor(0xFF16C784);
        title.setTextSize(13);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        tvMode = new TextView(svc);
        tvMode.setTextSize(10);
        tvMode.setTypeface(Typeface.DEFAULT_BOLD);
        tvMode.setPadding(px(8), 0, 0, 0);
        View sp = new View(svc);
        TextView min = chip("-", 0xFF2A3441);
        TextView close = chip("X", 0xFF2A3441);
        head.addView(title);
        head.addView(tvMode);
        head.addView(sp, new LinearLayout.LayoutParams(0, 1, 1f));
        head.addView(min);
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(-2, -2);
        cl.leftMargin = px(6);
        head.addView(close, cl);
        panel.addView(head);

        tvSignal = new TextView(svc);
        tvSignal.setText("WAIT");
        tvSignal.setTextColor(0xFFB0B8C4);
        tvSignal.setTextSize(24);
        tvSignal.setSingleLine(true);
        tvSignal.setTypeface(Typeface.DEFAULT_BOLD);
        panel.addView(tvSignal);

        tvInfo = new TextView(svc);
        tvInfo.setTextColor(0xFFB0B8C4);
        tvInfo.setTextSize(10.5f);
        tvInfo.setMaxLines(3);
        tvInfo.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tvInfo.setText("idle");
        panel.addView(tvInfo);

        btnAuto = chip("AUTO OFF", 0xFF3A4352);
        TextView scan = chip("SCAN", 0xFF1F6FEB);
        TextView buy = chip("BUY", 0xFF16A34A);
        TextView sell = chip("SELL", 0xFFDC2626);
        TextView closeAll = chip("CLOSE ALL", 0xFF7C2D12);
        TextView dbg = chip("DEBUG", 0xFF2A3441);
        TextView dump = chip("DUMP", 0xFF2A3441);
        TextView teach = chip("TEACH", 0xFF2A3441);

        LinearLayout r1 = rowOf();
        addChip(r1, btnAuto, true);
        addChip(r1, scan, false);
        panel.addView(r1);
        LinearLayout r2 = rowOf();
        addChip(r2, buy, true);
        addChip(r2, sell, false);
        addChip(r2, closeAll, false);
        panel.addView(r2);
        LinearLayout r3 = rowOf();
        addChip(r3, dbg, true);
        addChip(r3, dump, false);
        addChip(r3, teach, false);
        panel.addView(r3);

        tvLog = new TextView(svc);
        tvLog.setTextColor(0xFF7D8796);
        tvLog.setTextSize(10);
        tvLog.setMaxLines(4);
        tvLog.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tvLog.setPadding(0, px(6), 0, 0);
        panel.addView(tvLog);

        bubble = new TextView(svc);
        bubble.setText("K");
        bubble.setTextColor(Color.WHITE);
        bubble.setTextSize(18);
        bubble.setTypeface(Typeface.DEFAULT_BOLD);
        bubble.setGravity(Gravity.CENTER);
        bubble.setBackground(bg(0xF016C784, 28));
        bubble.setVisibility(View.GONE);

        root.addView(panel, new FrameLayout.LayoutParams(px(270), -2));
        root.addView(bubble, new FrameLayout.LayoutParams(px(48), px(48)));

        btnAuto.setOnClickListener(v -> bot.setAuto(!bot.isAuto()));
        scan.setOnClickListener(v -> bot.requestScan());
        dbg.setOnClickListener(v -> bot.requestDebug());
        dump.setOnClickListener(v -> bot.requestDump());
        teach.setOnClickListener(v -> startTeach());
        confirmChip(buy, "BUY", () -> bot.manual("buy"));
        confirmChip(sell, "SELL", () -> bot.manual("sell"));
        confirmChip(closeAll, "CLOSE ALL", () -> bot.manual("close"));
        close.setOnClickListener(v -> { bot.setAuto(false); remove(); });
        min.setOnClickListener(v -> collapse(true));

        drag(head);
        drag(title);
        drag(bubble);
        bubble.setOnClickListener(v -> collapse(false));

        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = px(8);
        lp.y = px(70);

        Flog.listener = () -> svc.mainHandler().post(this::refreshLog);
        refresh();
    }

    private void drag(View v) {
        final float[] d = new float[4];
        final boolean[] moved = new boolean[1];
        v.setOnTouchListener((view, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    d[0] = e.getRawX(); d[1] = e.getRawY(); d[2] = lp.x; d[3] = lp.y; moved[0] = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - d[0], dy = e.getRawY() - d[1];
                    if (Math.abs(dx) + Math.abs(dy) > 12) moved[0] = true;
                    if (moved[0]) {
                        android.graphics.Rect scr = svc.screen();
                        lp.x = Math.max(0, Math.min((int) (d[2] + dx), scr.width() - px(60)));
                        lp.y = Math.max(0, Math.min((int) (d[3] + dy), scr.height() - px(80)));
                        update();
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!moved[0]) view.performClick();
                    return true;
            }
            return false;
        });
    }

    private void update() { if (shown) try { wm.updateViewLayout(root, lp); } catch (Exception ignored) { } }

    private void collapse(boolean c) {
        panel.setVisibility(c ? View.GONE : View.VISIBLE);
        bubble.setVisibility(c ? View.VISIBLE : View.GONE);
        update();
    }

    void show() {
        if (shown) return;
        if (root == null) build();
        try { wm.addView(root, lp); shown = true; hidden = false; refresh(); }
        catch (Exception e) { Flog.i("overlay failed: " + e.getMessage()); }
    }

    void remove() {
        if (!shown) return;
        try { wm.removeView(root); } catch (Exception ignored) { }
        shown = false;
    }

    /** Invisible and touch-through, so screenshots and injected taps reach MT5. */
    void setHidden(boolean h) {
        svc.mainHandler().post(() -> {
            if (!shown) return;
            hidden = h;
            root.setVisibility(h ? View.INVISIBLE : View.VISIBLE);
            if (h) lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            else lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            update();
        });
    }

    void refresh() {
        svc.mainHandler().post(() -> {
            if (root == null) return;
            boolean dry = Cfg.b(svc, Cfg.DRY, true);
            tvMode.setText(dry ? "PAPER" : "LIVE");
            tvMode.setTextColor(dry ? 0xFFF0B90B : 0xFFEA3943);
            btnAuto.setText(bot.isAuto() ? "AUTO ON" : "AUTO OFF");
            btnAuto.setBackground(bg(bot.isAuto() ? 0xFF16A34A : 0xFF3A4352, 8));
            root.setKeepScreenOn(bot.isAuto());
            refreshLog();
        });
    }

    /** Full-screen catcher: the next tap is saved as the New Order button position (percent of screen). */
    void startTeach() {
        svc.mainHandler().post(() -> {
            final TextView cap = new TextView(svc);
            cap.setText("Tap the NEW ORDER button in MT5 now");
            cap.setTextColor(Color.WHITE);
            cap.setTextSize(18);
            cap.setGravity(Gravity.CENTER);
            cap.setBackgroundColor(0x88000000);
            final WindowManager.LayoutParams p = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            cap.setOnTouchListener((v, e) -> {
                if (e.getActionMasked() == MotionEvent.ACTION_UP) {
                    android.graphics.Rect scr = svc.screen();
                    Cfg.put(svc, Cfg.NO_X, String.format(java.util.Locale.US, "%.2f", e.getRawX() * 100.0 / scr.width()));
                    Cfg.put(svc, Cfg.NO_Y, String.format(java.util.Locale.US, "%.2f", e.getRawY() * 100.0 / scr.height()));
                    try { wm.removeView(cap); } catch (Exception ignored) { }
                    Flog.i("New Order button position saved");
                }
                return true;
            });
            try { wm.addView(cap, p); } catch (Exception ex) { Flog.i("teach failed: " + ex.getMessage()); }
        });
    }

    private void refreshLog() { if (tvLog != null) tvLog.setText(Flog.tail()); }

    void setSignal(String action, String info) {
        svc.mainHandler().post(() -> {
            if (tvSignal == null) return;
            tvSignal.setText(action);
            tvSignal.setTextColor(action.equals("BUY") ? 0xFF16C784 : action.equals("SELL") ? 0xFFEA3943 : 0xFFB0B8C4);
            tvInfo.setText(info);
        });
    }
}
