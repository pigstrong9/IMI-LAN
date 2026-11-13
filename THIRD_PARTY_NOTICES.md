# 第三方组件与参考实现

本项目的原创部分（`web/app.js`、`web/index.html`、`web/style.css`、`qr-login.js`、`desktop/`、启动脚本）采用 [MIT License](LICENSE)，见仓库根目录 `LICENSE`。
下面列出捆绑或参考的第三方项目及其许可证。

> 随仓库分发的第三方源码必须携带其版权与许可声明，因此 `web/video-rtc.js` 和 `web/video-stream.js`
> 的文件头保留了 go2rtc 的出处与版权声明，请勿删除。

## go2rtc（MIT）

- 项目：https://github.com/AlexxIT/go2rtc
- 使用方式：捆绑 `go2rtc.exe`；fnOS 版在构建时下载 1.9.15 源码并应用 `fpk/patches/xiaomi-login.patch`，交叉编译出 Linux 版；`web/video-rtc.js` 来自其 MIT 许可的播放器。
- 补丁内容：小米登录 `finishAuth` 请求携带 `passToken`/`userId` Cookie，修复 401；登录成功后把轮换的 `passToken` 写回配置，避免引擎重启要求重新扫码；配置写入改为临时文件原子替换并保持 0600；补丁本身同样按 MIT 使用。
- 版权：Copyright (c) 2022 Alexey Khit

```
MIT License

Copyright (c) 2022 Alexey Khit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MijiaLAN / MenuBarMijia（MijiaCore）（MIT）

- 项目：https://github.com/iPocket-APP/MijiaLAN
- 使用方式：仅作为小米账号二维码登录流程（取 ticket → 长轮询 → 跟随重定向拿 token）的参考实现。
- 说明：`qr-login.js` 是使用 Node 内置模块独立实现的，未包含、未修改其源码。
- 版权：Copyright (c) iPocket-APP

该项目的 MIT 许可证文本与上面的 MIT 文本相同；其仓库内
`Vendor/MenuBarMijia/LICENSE` 保留了原始版权声明。

## hass-xiaomi-miot（Apache-2.0）

- 项目：https://github.com/al-one/hass-xiaomi-miot
- 使用方式：仅作为小米设备兼容性、型号与 `subtype` 资料的参考。
- 说明：本项目未包含其 Python 代码、模板或 `legacy-miio.json` 转换数据。
- 许可证：Apache License 2.0，全文见上游仓库的 `LICENSE`。

## ffmpeg（GPL-3，仓库不含，仅本机使用）

- 项目：https://ffmpeg.org
- 使用方式：`go2rtc.yaml` 的 `ffmpeg.bin` 指向 `bin/ffmpeg.exe`，go2rtc 以**独立进程**调用它做 H.265 转码兜底。本项目代码不与它链接，也不包含其任何源码。
- 分发范围：`bin/` 已在 `.gitignore` 中，仓库里**没有** ffmpeg 的任何文件，请按 README 自行下载。
- **许可类型要注意**：开发时用的那个构建带 `--enable-gpl --enable-version3`，属于 **GPL-3.0 或更高**，不是 LGPL。GPL 的义务在**再分发**时才触发——把 `bin/` 连同便携版目录打包发给别人，就必须同时提供该构建的完整对应源码或书面源码要约。
- 实践结论：便携版目录只自用；要分享给别人就别带 `bin/`，或改用 LGPL 构建并附许可证与源码链接。

## Electron 与 Chromium（MIT / BSD 等）

- 项目：https://www.electronjs.org （MIT）
- 使用方式：`desktop/` 用它打包桌面版；`desktop/node_modules/` 与 `desktop/dist/` 都不入库。

## Node.js（MIT）· 仅 fnOS 版依赖

- 项目：https://nodejs.org （MIT）
- 使用方式：fnOS 版在 `manifest` 里声明 `install_dep_apps=nodejs_v22`，由飞牛应用中心安装运行时并调用它启动二维码助手；本项目**不随包分发** Node.js 二进制。
- 说明：electron-packager 的产物自带 `LICENSE` 和 `LICENSES.chromium.html`（Chromium 及其依赖的完整第三方声明）。若要分发便携版，这两个文件必须一起保留。

## Android 版：Go 运行时与 Kotlin（BSD / Apache-2.0）

- Go（BSD-3-Clause）：https://go.dev 。安卓版的 go2rtc 与网关是用 Go 交叉编译的 Linux 二进制，随 APK 分发；其许可证与版权声明见 Go 源码树的 `LICENSE`。
- Kotlin 标准库与 Android Gradle Plugin（Apache-2.0）：仅用于构建 App 壳，运行时随 APK 附带 Kotlin 标准库。
- Android 平台代码（Apache-2.0）：来自 Android SDK，不随本项目源码分发。

## CA 证书包（MPL-2.0）

- 来源：Mozilla 的 CA 证书库，经 Python `certifi` 汇总。
- 使用方式：`android/app/src/main/assets/ca.pem` 随 APK 分发，供 Go 的 `x509` 在 Android 上校验 HTTPS（`SSL_CERT_FILE`）。证书本身不属于版权客体，汇总文件按 MPL-2.0 使用。
- 更新方式：从 https://github.com/certifi/python-certifi 取最新 `cacert.pem` 覆盖即可。

