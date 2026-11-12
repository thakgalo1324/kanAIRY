package com.kanairy.trader;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/** What the Kanairy web UI can ask the phone to do. Only our own bundled pages are loaded, so only they can call this. */
final class Bridge {
    private final MainActivity act;
    private final WebView web;

    private String tok = java.util.UUID.randomUUID().toString();
    private boolean given;

    Bridge(MainActivity act, WebView web) { this.act = act; this.web = web; }

    /** New page load: new secret. Only the first caller (our own page script) can fetch it, so frames loaded later cannot use the bridge. */
    synchronized void reset() { tok = java.util.UUID.randomUUID().toString(); given = false; }

    @JavascriptInterface
    public synchronized String token() {
        if (given) return "";
        given = true;
        return tok;
    }

    private synchronized boolean ok(String t) { return t != null && t.equals(tok); }

    private KanairyService svc() { return KanairyService.instance; }

    @JavascriptInterface
    public String status(String t) {
        if (!ok(t)) return "{}";
        JSONObject o = new JSONObject();
        try {
            KanairyService s = svc();
            o.put("svc", s != null);
            if (s != null) s.bot().fill(o);
            else o.put("auto", false).put("dry", Cfg.b(act, Cfg.DRY, true)).put("scalp", Cfg.b(act, Cfg.SCALP, false))
                    .put("mode", Cfg.s(act, Cfg.MODE, "lab")).put("action", "WAIT").put("mt5", false);
            PowerManager pm = (PowerManager) act.getSystemService(Context.POWER_SERVICE);
            o.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(act.getPackageName()));
            JSONArray log = new JSONArray();
            for (String l : Flog.tail().split("\n")) if (!l.isEmpty()) log.put(l);
            o.put("log", log);
        } catch (Exception ignored) { }
        return o.toString();
    }

    @JavascriptInterface
    public String events(String t) { return ok(t) ? Events.json(act) : "[]"; }

    @JavascriptInterface
    public void setAuto(String t, boolean on) {
        if (!ok(t)) return;
        KanairyService s = svc();
        if (s == null) { toast("Turn on Kanairy in Accessibility first"); return; }
        s.bot().setAuto(on);
    }

    private void toast(String m) { act.runOnUiThread(() -> Toast.makeText(act, m, Toast.LENGTH_SHORT).show()); }

    private void go(Intent i) { act.runOnUiThread(() -> { try { act.startActivity(i); } catch (Exception e) { toast("Cannot open that screen"); } }); }

    private void applyScalp(boolean on) {
        String[][] pre = on
                ? new String[][]{{Cfg.THR, "3"}, {Cfg.SL_ATR, "0.8"}, {Cfg.RR, "1.2"}, {Cfg.INTERVAL, "6"}, {Cfg.MAX_OPEN, "3"}, {Cfg.MAX_DAY, "40"}, {Cfg.COOLDOWN, "0.5"}, {Cfg.HOLD_MIN, "5"}}
                : new String[][]{{Cfg.THR, "3"}, {Cfg.SL_ATR, "1.5"}, {Cfg.RR, "2"}, {Cfg.INTERVAL, "20"}, {Cfg.MAX_OPEN, "1"}, {Cfg.MAX_DAY, "20"}, {Cfg.COOLDOWN, "2"}, {Cfg.HOLD_MIN, "0"}};
        for (String[] kv : pre) Cfg.put(act, kv[0], kv[1]);
        Cfg.putB(act, Cfg.SCALP, on);
        toast(on ? "Scalp preset applied. Use a 1 minute chart." : "Normal preset applied");
    }

    @JavascriptInterface
    public void act(String t, String name) {
        if (!ok(t)) return;
        final KanairyService s = svc();
        switch (name) {
            case "scan": if (s == null) toast("Turn on Kanairy in Accessibility first"); else s.bot().requestScan(); break;
            case "debug": if (s != null) s.bot().requestDebug(); break;
            case "dump": if (s != null) s.bot().requestDump(); break;
            case "overlay": if (s != null) s.showOverlay(); else toast("Turn on Kanairy in Accessibility first"); break;
            case "teach":
                if (s == null) { toast("Turn on Kanairy in Accessibility first"); break; }
                openMt5();
                toast("Go to the MT5 chart. Tap New Order when the screen dims.");
                s.mainHandler().postDelayed(() -> s.overlay().startTeach(), 5000);
                break;
            case "mt5": openMt5(); break;
            case "a11y": go(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); break;
            case "appinfo": go(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + act.getPackageName()))); break;
            case "battery": go(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); break;
            case "buy": case "sell": case "close": case "stop":
                if (s == null) { toast("Turn on Kanairy in Accessibility first"); break; }
                s.bot().manual(name);
                toast("Kanairy is on it. Open MT5 to watch.");
                openMt5();
                break;
            case "scalp_on": applyScalp(true); break;
            case "scalp_off": applyScalp(false); break;
            default: break;
        }
        if (s != null && s.overlay() != null) s.overlay().refresh();
    }

    private void openMt5() {
        Intent i = act.getPackageManager().getLaunchIntentForPackage(Mt5Driver.PKG);
        if (i == null) toast("MT5 is not installed"); else go(i);
    }

    @JavascriptInterface public String getCfg(String t, String k, String d) { return ok(t) ? Cfg.s(act, k, d) : d; }
    @JavascriptInterface public void setCfg(String t, String k, String v) { if (ok(t)) Cfg.put(act, k, v); }
    @JavascriptInterface public boolean getFlag(String t, String k, boolean d) { return ok(t) ? Cfg.b(act, k, d) : d; }

    @JavascriptInterface
    public void setFlag(String t, String k, boolean v) {
        if (!ok(t)) return;
        Cfg.putB(act, k, v);
        KanairyService s = svc();
        if (s != null && s.overlay() != null) s.overlay().refresh();
    }

    @JavascriptInterface public String getStrategy(String t) { return ok(t) ? Cfg.s(act, Cfg.STRAT, "") : ""; }
    @JavascriptInterface public void setStrategy(String t, String json) { if (ok(t)) Cfg.put(act, Cfg.STRAT, json == null ? "" : json); }

    @JavascriptInterface
    public boolean saveFile(String t, String name, String text) {
        if (!ok(t)) return false;
        return Files.saveTextAs(act, name.replaceAll("[^A-Za-z0-9._-]", "_"), text, "text/xml");
    }

    // ---------- Kanairy server on your VPS ----------

    @JavascriptInterface
    public void saveVps(String t, String url, String key) {
        if (!ok(t)) return;
        String u = url == null ? "" : url.trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (!u.isEmpty() && !u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        Cfg.put(act, "vps_url", u);
        if (key != null && !key.trim().isEmpty()) {
            Vault.put(act, "vpskey", key.trim());
            // A different app key means the saved sign-in no longer matches, so sign in again.
            Cfg.put(act, "vps_user", "");
            Vault.put(act, "userkey", "");
        }
    }

    private static String sha256hex(String in) throws Exception {
        byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(in.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    /** The key for one person is derived from the shared app key, their name and their PIN. The PIN itself is never sent or stored. */
    @JavascriptInterface
    public String deriveUserKey(String t, String name, String pin) {
        if (!ok(t)) return "";
        try { return sha256hex(Vault.get(act, "vpskey") + ":" + name.trim().toLowerCase(java.util.Locale.ROOT) + ":" + pin); } catch (Exception e) { return ""; }
    }

    @JavascriptInterface
    public void saveUser(String t, String name, String pin) {
        if (!ok(t)) return;
        String n = name == null ? "" : name.trim().toLowerCase(java.util.Locale.ROOT);
        String k = deriveUserKey(t, n, pin == null ? "" : pin);
        if (n.isEmpty() || k.isEmpty()) return;
        Cfg.put(act, "vps_user", n);
        Vault.put(act, "userkey", k);
    }

    @JavascriptInterface
    public void clearUser(String t) {
        if (!ok(t)) return;
        Cfg.put(act, "vps_user", "");
        Vault.put(act, "userkey", "");
    }

    @JavascriptInterface
    public String vpsInfo(String t) {
        if (!ok(t)) return "{}";
        try {
            return new JSONObject().put("url", Cfg.s(act, "vps_url", "")).put("hasKey", Vault.has(act, "vpskey"))
                .put("user", Cfg.s(act, "vps_user", "")).toString();
        } catch (Exception e) { return "{}"; }
    }

    /** Signed request to the Kanairy server. The key is never sent, only a one-time HMAC signature. */
    @JavascriptInterface
    public void vps(String t, final int id, final String method, final String path, final String body) {
        if (!ok(t)) return;
        new Thread(() -> {
            int status = 0;
            String text = "";
            try {
                String base = Cfg.s(act, "vps_url", "");
                String key = Vault.get(act, "vpskey");
                String user = Cfg.s(act, "vps_user", "");
                // Creating an account and the first hello use the shared key. Everything else is signed with this person's own key.
                boolean shared = path.startsWith("/api/hello") || path.startsWith("/api/register");
                if (!shared && !user.isEmpty()) key = Vault.get(act, "userkey");
                else user = "";
                if (base.isEmpty() || key.isEmpty()) throw new IllegalStateException("not configured");
                String b = body == null ? "" : body;
                String ts = String.valueOf(System.currentTimeMillis());
                byte[] nb = new byte[6];
                new java.security.SecureRandom().nextBytes(nb);
                StringBuilder nsb = new StringBuilder();
                for (byte x : nb) nsb.append(String.format("%02x", x));
                String nonce = nsb.toString();
                javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
                mac.init(new javax.crypto.spec.SecretKeySpec(key.getBytes("UTF-8"), "HmacSHA256"));
                byte[] raw = mac.doFinal((ts + "\n" + nonce + "\n" + method + "\n" + path + "\n" + b).getBytes("UTF-8"));
                StringBuilder sig = new StringBuilder();
                for (byte x : raw) sig.append(String.format("%02x", x));
                HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(10000);
                c.setRequestMethod(method);
                c.setRequestProperty("X-Ts", ts);
                c.setRequestProperty("X-Nonce", nonce);
                c.setRequestProperty("X-Sig", sig.toString());
                if (!user.isEmpty()) c.setRequestProperty("X-User", user);
                c.setRequestProperty("Content-Type", "application/json");
                if (!b.isEmpty()) {
                    c.setDoOutput(true);
                    c.getOutputStream().write(b.getBytes("UTF-8"));
                }
                status = c.getResponseCode();
                InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
                if (in != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n, total = 0;
                    while ((n = in.read(buf)) > 0 && total < 2_000_000) { bo.write(buf, 0, n); total += n; }
                    text = bo.toString("UTF-8");
                }
            } catch (Exception e) {
                status = 0;
                text = String.valueOf(e.getMessage());
            }
            final int st = status;
            final String tx = text;
            web.post(() -> web.evaluateJavascript("window.__vpsCb(" + id + "," + st + "," + JSONObject.quote(tx) + ")", null));
        }).start();
    }

    @JavascriptInterface
    public void http(String t, final int id, final String url) {
        if (!ok(t)) return;
        new Thread(() -> {
            int status = 0;
            String body = "";
            try {
                if (!url.startsWith("https://")) throw new IllegalArgumentException("https only");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(20000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
                c.setRequestProperty("Accept", "application/json,text/xml,application/xml,text/html;q=0.9,*/*;q=0.8");
                status = c.getResponseCode();
                InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
                if (in != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n, total = 0;
                    while ((n = in.read(buf)) > 0 && total < 3_000_000) { bo.write(buf, 0, n); total += n; }
                    body = bo.toString("UTF-8");
                }
            } catch (Exception e) {
                status = 0;
            }
            final int st = status;
            final String b = body;
            web.post(() -> web.evaluateJavascript("window.__http(" + id + "," + st + "," + JSONObject.quote(b) + ")", null));
        }).start();
    }
}
