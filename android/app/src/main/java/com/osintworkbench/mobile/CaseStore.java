package com.osintworkbench.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

final class CaseStore extends SQLiteOpenHelper {
    CaseStore(Context context) { super(context, "osint_mobile.db", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE cases (_id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, phone TEXT NOT NULL, note TEXT, details TEXT NOT NULL, created_at INTEGER NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    long add(String title, String phone, String note, String details) {
        ContentValues v = new ContentValues();
        v.put("title", title); v.put("phone", phone); v.put("note", note);
        v.put("details", details); v.put("created_at", System.currentTimeMillis());
        return getWritableDatabase().insertOrThrow("cases", null, v);
    }
    Cursor all() {
        return getReadableDatabase().query("cases",
            new String[]{"_id","title","phone","note","details","created_at"},
            null,null,null,null,"created_at DESC");
    }
    int delete(long id) {
        return getWritableDatabase().delete("cases","_id=?",new String[]{String.valueOf(id)});
    }
}
