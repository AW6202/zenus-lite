# TWA 壳（APK）

把 https://aw6202.github.io/zenus-lite/ 包成 Android APK（Trusted Web Activity）。

- 包名：`io.github.aw6202.zenus`
- 作用：注册 `https://aw6202.github.io/zenus-lite` 的 VIEW intent →
  **微信「用其他应用打开」/ 系统分享列表里能出现学习机**
- 全屏（无地址栏）依赖根域校验文件：https://aw6202.github.io/.well-known/assetlinks.json
  （在仓库 `AW6202/aw6202.github.io`；改了签名密钥必须同步改那里的 sha256）
- 内容更新**不用重新打包**：壳只是打开网址，`git push` 后 APK 里看到的还是最新版

## 构建

需要 JDK 17 + Android SDK（platform 34 / build-tools 34）+ Gradle 8.5：

```bash
cd android-twa
gradle assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

签名配置在 `app/build.gradle`，读取 `C:/android-build/zenus.keystore` 与密码文件。
**密钥丢了就得卸载重装**（签名不一致系统会拒绝覆盖安装）。
