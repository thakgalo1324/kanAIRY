package com.kanairy.trader;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

/** Persistent history of signals, orders and exits shown on the Activity page. */
public final class Events {
    private Events() {}
    private static JSONArray list;

    private static synchronized void load(Context c) {
        if (list != null) return;
        try { list = new JSONArray(Cfg.s(c, "events", "[]")); } catch (Exception e) { list = new JSONArray(); }
    }

    public static synchronized void add(Context c, String kind, String text) {
        load(c);
        try {
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis()).put("kind", kind).put("text", text);
            JSONArray n = new JSONArray();
            n.put(o);
            for (int i = 0; i < list.length() && n.length() < 100; i++) n.put(list.get(i));
            list = n;
            Cfg.put(c, "events", list.toString());
        } catch (Exception ignored) { }
    }

    public static synchronized String json(Context c) {
        load(c);
        return list.toString();
    }
}
