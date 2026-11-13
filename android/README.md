# IMI-LAN 安卓版（本机独立运行）

这个目录把整套 IMI-LAN 塞进一个 APK：**go2rtc、网关、扫码登录全部在手机里运行**，不需要电脑或飞牛，也不依赖 Node。装好后打开 App 就是和桌面版一样的网页界面。

## 它做了什么

- `go2rtc` 与网关用 Go 交叉编译成 Linux ARM64 / x86_64 二进制，以 `libgo2rtc.so` / `libimi-gateway.so` 的名字放进 `jniLibs`。Android 只有 `nativeLibraryDir` 允许应用直接执行文件，所以必须用 `useLegacyPackaging = true` + `extractNativeLibs="true"`。
- 启动时前台服务把两个进程拉起来，网页网关固定在 `127.0.0.1:19841`，go2rtc API 端口首次启动时在 20000–29999 里随机挑一个写进 `go2rtc.yaml`。
- 网关带 `-app-token`，WebView 通过 `CookieManager` 写入 `imi_app=<随机令牌>`；API 只经网关代理，同机其他应用无法直接读取小米 token。`/health` 仍然免令牌，方便系统探测。
- 扫码登录由 `fpk/gateway/qr.go` 完成（从 `qr-login.js` 移植），不需要 Node。
- 安卓没有 `/etc/resolv.conf`，`Engine` 从 `ConnectivityManager` 读出当前 DNS，用 `IMI_DNS` 环境变量传给引擎；同时用 APK 内置的 `ca.pem` 作为 `SSL_CERT_FILE`，否则 Go 的 x509 找不到系统根证书。
- 截图 / 录像不再用 `<a download>`（WebView 不触发下载），而是经 `IMIAndroid` JS 桥分块 base64 写入系统相册的 `Pictures/IMI-LAN`、`Movies/IMI-LAN`。
- 安卓 WebView 对 H.265 支持参差，网页检测到 `IMIAndroid.preferSD()` 后默认走「流畅」子码流；导入摄像头时也会直接把地址落成子码流。想试主码流可以在卡片上手动切「高清」。

## 构建

需要：

- Go 1.22+（`--go` 或 `GO`）
- JDK 17+（`--jdk` 或 `JAVA_HOME`）
- Android SDK：platform 35、build-tools 36.0.0（`--sdk`、`ANDROID_HOME` 或默认 `%LOCALAPPDATA%\Android\Sdk`）
- Gradle 8.13+（`--gradle` 或 `GRADLE`）

```bash
# 默认出 arm64-v8a + x86_64 两个 debug APK
python android/build.py --go /path/to/go --gradle /path/to/gradle --jdk /path/to/jdk

# 只出真机用的 arm64
python android/build.py --abi arm64-v8a

# 正式包（需要 android/keystore.properties）
python android/build.py --release
```

脚本会：

1. 复用/生成 `fpk/.build` 里已打补丁的 go2rtc 源码；
2. 交叉编译两个 ABI 的引擎与网关，做 ELF 架构校验；
3. 把 `web/` 复制到 `app/src/main/assets/web`；
4. 写 `local.properties` 并调用 Gradle（默认先 `clean`，否则增量打包会在 APK 里留下旧填充，体积越滚越大）；
5. 把产物复制到 `android/dist/`，命名 `imi-lan_<版本>_<abi>_<debug|release>.apk`，并检查 APK 里的 `lib/<abi>/*.so`、`assets/web/index.html`、`assets/go2rtc.yaml`、`assets/ca.pem`。

`--skip-native` 可以跳过 Go 编译，复用上一次的 `jniLibs`，只改 Kotlin/网页时更快；配合 `--no-clean` 还能跳过 `clean`。这两个只用于本地迭代，出正式包不要带。

仓库路径含中文也能构建：`gradle.properties` 里已设置 `android.overridePathCheck=true`。

发布签名放在 `android/keystore.properties`（已在 `.gitignore` 里）：

```properties
storeFile=../keystore/imi-lan.jks
storePassword=...
keyAlias=imi-lan
keyPassword=...
```

没有这个文件时 `--release` 会用 debug 签名，只能自己装。

## 安装与使用

```powershell
adb install -r android/dist/imi-lan_1.0.1_arm64_debug.apk
```

或把 APK 拷到手机上点击安装（需要允许「安装未知应用」）。

首次启动：

1. 允许通知权限（引擎常驻的前台服务需要，否则 Android 13+ 会收掉服务）；
2. 等 5–20 秒，页面自动打开；
3. 点「扫码登录」，用米家 App 扫码；
4. 「添加摄像头」选设备，导入后即可观看。

通知栏有「重启引擎」「停止」两个动作。停止后再次打开 App 会自动重新启动。

## 数据与端口

| 内容 | 位置 |
| --- | --- |
| 配置（含小米令牌） | `/data/data/io.github.imilan/files/engine/go2rtc.yaml` |
| 网页资源 | `/data/data/io.github.imilan/files/engine/web/` |
| 日志 | `/data/data/io.github.imilan/files/engine/engine.log`、`gateway.log` |
| 网页 / API 网关 | `127.0.0.1:19841`（仅本机，固定） |
| go2rtc API | `127.0.0.1:20000–29999`（首次启动随机，仅本机） |
| RTSP / WebRTC | `127.0.0.1:20000–29999`（首次启动随机，仅本机） |

卸载 App 会连同令牌和配置一起删除。想保留配置可以先在网页里重新扫码，或把 `go2rtc.yaml` 拷出来（需要 root 或 `adb backup` 之外的手段，`allowBackup=false`）。

## 已知限制

- 只支持 arm64-v8a（绝大多数手机/平板）和 x86_64（模拟器）。armeabi-v7a 不提供，Go 的 WebRTC 依赖在 32 位 ARM 上不稳。
- 不内置 ffmpeg：H.265 主码流在部分设备上解不出来时，请用「流畅」子码流（默认已经是）。若摄像头没有子码流，只能换设备或等后续版本。
- 与桌面版共用配置格式，但数据各自独立；把桌面版 `go2rtc.yaml` 拷到手机上没有直接入口，建议重新扫码导入。
- 侧载分发，未上架 Google Play。Android 15+ 前台服务类型用 `connectedDevice`，不需要定位/蓝牙权限。
- 首次启动需要联网访问 `account.xiaomi.com` 扫码；局域网观看本身不经过云端。

## 调试

```powershell
# 看引擎日志
adb shell run-as io.github.imilan cat files/engine/engine.log
adb shell run-as io.github.imilan cat files/engine/gateway.log

# 确认端口（需要 root 或 adb forward 到本机）
adb forward tcp:29841 tcp:19841
# 浏览器打开 http://127.0.0.1:29841/?app  （会因为没有 Cookie 返回 401，属正常）
```

debug 包在 Chrome `chrome://inspect` 里可以直接调试 WebView。
