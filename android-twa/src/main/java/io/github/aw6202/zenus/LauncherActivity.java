package io.github.aw6202.zenus;

// 打开 Trusted Web Activity；assetlinks 校验失败时自动回落 Custom Tab。
// 注意：不能 import 同名的父类，直接用全限定名。
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
}
