package io.github.aw6202.zenus;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * 打开 Trusted Web Activity。
 * 1) 把「用其他应用打开 / 分享」传进来的链接或文字，转成学习机的 ?import= 参数；
 * 2) TWA 起不来（没有可用的浏览器内核 / 校验失败）时不让应用闪退，退化为用浏览器打开。
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
        if (incoming.startsWith(BASE)) {
            return Uri.parse(incoming);
        }
        return Uri.parse(BASE + "?import=" + Uri.encode(incoming));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        try {
            super.onCreate(savedInstanceState);
        } catch (Throwable t) {
            // 兜底：TWA 启动失败也绝不能闪退，改用系统浏览器打开
            try {
                Intent view = new Intent(Intent.ACTION_VIEW, getLaunchingUrl());
                view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(view);
            } catch (Throwable ignored) {
                // 实在打不开就算了，至少不崩
            }
            finish();
        }
    }
}
