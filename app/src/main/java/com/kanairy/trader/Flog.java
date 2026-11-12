package com.kanairy.trader;

import android.util.Log;
import java.util.ArrayDeque;
import java.util.Deque;

public final class Flog {
    private Flog() {}
    private static final Deque<String> lines = new ArrayDeque<>();
    public static volatile Runnable listener;

    public static synchronized void i(String m) {
        Log.i("Kanairy", m);
        lines.addLast(m);
        while (lines.size() > 5) lines.removeFirst();
        Runnable l = listener;
        if (l != null) l.run();
    }

    public static synchronized String tail() {
        StringBuilder sb = new StringBuilder();
        for (String s : lines) sb.append(s).append('\n');
        return sb.toString().trim();
    }
}
