package com.kanairy.trader;

import android.content.Context;
import android.content.SharedPreferences;

public final class Cfg {
    private Cfg() {}

    public static final String LOT = "lot", SL_ATR = "sl_atr", RR = "rr", THR = "thr", INTERVAL = "interval",
            MAX_OPEN = "max_open", MAX_DAY = "max_day", COOLDOWN = "cooldown", COLOR = "color",
            M_TOP = "m_top", M_BOT = "m_bot", M_RIGHT = "m_right", M_LEFT = "m_left",
            NO_X = "no_x", NO_Y = "no_y", DRY = "dry", POS_CHECK = "pos_check", AUTO_SHOW = "auto_show", SCALP = "scalp", HOLD_MIN = "hold_min",
            MODE = "mode", STRAT = "strategy_json", AUTO_REGION = "auto_region", AUTO_ZOOM = "auto_zoom", ENHANCE = "enhance";

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences("flmr", Context.MODE_PRIVATE);
    }

    public static String s(Context c, String k, String d) { return sp(c).getString(k, d); }

    public static double d(Context c, String k, double d) {
        try { return Double.parseDouble(sp(c).getString(k, String.valueOf(d)).trim().replace(',', '.')); }
        catch (Exception e) { return d; }
    }

    public static int i(Context c, String k, int d) { return (int) Math.round(d(c, k, d)); }

    public static boolean b(Context c, String k, boolean d) { return sp(c).getBoolean(k, d); }

    public static void put(Context c, String k, String v) { sp(c).edit().putString(k, v).apply(); }

    public static void putB(Context c, String k, boolean v) { sp(c).edit().putBoolean(k, v).apply(); }
}
