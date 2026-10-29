package io.github.aw6202.zenus;

import android.content.Intent;
import android.net.Uri;

/**
 * 打开 Trusted Web Activity。
 * 关键：把「用其他应用打开 / 分享」传进来的链接或文字，转成学习机的 ?import= 参数，
 * 由网页端抓正文并导入（否则这里永远只会打开固定首页，等于没用）。
 */
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String BASE = "https://aw6202.github.io/zenus-lite/";

    @Override
    protected Uri getLaunchingUrl() {
        String incoming = null;
        Intent intent = getIntent();
        if (intent != null) {
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                incoming = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (incoming == null) incoming = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            } else if (intent.getData() != null) {
                incoming = intent.getData().toString();
            }
        }
        if (incoming == null || incoming.trim().isEmpty()) {
            return Uri.parse(BASE);
        }
        incoming = incoming.trim();
        // 我们自己站内的链接就直接打开，别套一层 import
        if (incoming.startsWith(BASE)) {
            return Uri.parse(incoming);
        }
        return Uri.parse(BASE + "?import=" + Uri.encode(incoming));
    }
}
