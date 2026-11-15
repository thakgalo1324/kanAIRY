package com.kanairy.trader;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Keeps the broker password encrypted with a key that never leaves the Android Keystore. */
final class Vault {
    private Vault() {}

    private static final String ALIAS = "kanairy_vault";
    private static final String PROVIDER = "AndroidKeyStore";

    private static SecretKey create() throws Exception {
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return g.generateKey();
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(PROVIDER);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            try {
                SecretKey k = (SecretKey) ks.getKey(ALIAS, null);
                if (k != null) return k;
            } catch (Exception e) { Flog.i("vault key unusable, making a new one: " + e.getMessage()); }
            try { ks.deleteEntry(ALIAS); } catch (Exception ignored) { }
        }
        return create();
    }

    static void put(Context c, String name, String plain) {
        try {
            if (plain == null || plain.isEmpty()) { Cfg.put(c, "vault_" + name, ""); return; }
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, key());
            byte[] enc = ci.doFinal(plain.getBytes("UTF-8"));
            byte[] iv = ci.getIV();
            Cfg.put(c, "vault_" + name, Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP));
        } catch (Exception e) { Flog.i("vault save failed: " + e.getMessage()); }
    }

    static String get(Context c, String name) {
        try {
            String v = Cfg.s(c, "vault_" + name, "");
            if (v.isEmpty()) return "";
            String[] p = v.split(":");
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p[0], Base64.NO_WRAP)));
            return new String(ci.doFinal(Base64.decode(p[1], Base64.NO_WRAP)), "UTF-8");
        } catch (Exception e) { return ""; }
    }

    /** True only when the saved value can really be decrypted. A value left over from an old key counts as missing, so the app asks again instead of staying stuck. */
    static boolean has(Context c, String name) { return !get(c, name).isEmpty(); }
}
