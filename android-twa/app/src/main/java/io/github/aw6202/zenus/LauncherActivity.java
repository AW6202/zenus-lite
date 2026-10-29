package io.github.aw6202.zenus;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * 打开 Trusted Web Activity。
 * 除了把外来的链接转成 ?import=，还会把「微信到底传了什么 intent」编码进 URL，
 * 这样网页端的诊断条能直接看到 action/data/extra，便于定位。
 */
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String BASE = "https://aw6202.github.io/zenus-lite/";

    private static String clip(String s, int n) {
        if (s == null) return "";
        return s.length() > n ? s.substring(0, n) + "..." : s;
    }

    @Override
    protected Uri getLaunchingUrl() {
        Intent it = getIntent();
        String action = it != null && it.getAction() != null ? it.getAction() : "";
        String data = it != null && it.getData() != null ? it.getData().toString() : "";
        String extra = it != null ? it.getStringExtra(Intent.EXTRA_TEXT) : null;
        String subject = it != null ? it.getStringExtra(Intent.EXTRA_SUBJECT) : null;

        String incoming = !data.isEmpty() ? data : (extra != null ? extra : "");
        if (incoming.startsWith(BASE)) {
            return Uri.parse(incoming);           // 自己站内的链接，原样打开
        }

        StringBuilder q = new StringBuilder();
        q.append("apk=1&act=").append(Uri.encode(clip(action, 60)));
        q.append("&data=").append(Uri.encode(clip(data, 200)));
        q.append("&extra=").append(Uri.encode(clip(extra, 200)));
        q.append("&subject=").append(Uri.encode(clip(subject, 80)));
        if (!incoming.trim().isEmpty()) {
            q.insert(0, "import=" + Uri.encode(clip(incoming.trim(), 1500)) + "&");
        }
        return Uri.parse(BASE + "?" + q);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        try {
            super.onCreate(savedInstanceState);
        } catch (Throwable t) {
            // 兜底：TWA 启动失败也绝不闪退，改用系统浏览器打开
            try {
                Intent view = new Intent(Intent.ACTION_VIEW, getLaunchingUrl());
                view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(view);
            } catch (Throwable ignored) { }
            finish();
        }
    }
}
