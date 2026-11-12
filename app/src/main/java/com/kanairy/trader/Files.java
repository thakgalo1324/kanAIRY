package com.kanairy.trader;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.provider.MediaStore;
import java.io.OutputStream;

/** Saves debug output where the user can open it: Downloads/FLMR and Pictures/Kanairy. */
public final class Files {
    private Files() {}

    public static boolean saveText(Context c, String name, String text) {
        return saveTextAs(c, name, text, "text/plain");
    }

    public static boolean saveTextAs(Context c, String name, String text, String mime) {
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Kanairy");
            ContentResolver r = c.getContentResolver();
            Uri u = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (u == null) return false;
            try (OutputStream o = r.openOutputStream(u)) { o.write(text.getBytes("UTF-8")); }
            return true;
        } catch (Exception e) { Flog.i("save failed: " + e.getMessage()); return false; }
    }

    public static boolean savePng(Context c, String name, Bitmap b) {
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/Kanairy");
            ContentResolver r = c.getContentResolver();
            Uri u = r.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (u == null) return false;
            try (OutputStream o = r.openOutputStream(u)) { b.compress(Bitmap.CompressFormat.PNG, 100, o); }
            return true;
        } catch (Exception e) { Flog.i("save failed: " + e.getMessage()); return false; }
    }
}
