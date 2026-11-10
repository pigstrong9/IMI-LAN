# IMI-LAN · fnOS（飞牛）版

把 IMI-LAN 打包成飞牛 fnOS 的原生应用（`.fpk`）。安装后，局域网内的手机、平板、电脑和电视都可以用浏览器访问：

```text
http://<飞牛主机地址>:1984
```

Web 界面第一次打开会弹出浏览器登录框，用户名固定为 `imi`，密码是安装向导里设置的那个。

## 和 Windows 版的区别

| | Windows 桌面版 | fnOS 原生版 |
| --- | --- | --- |
| 引擎 | `go2rtc.exe` | 交叉编译的 Linux 版，带小米登录 401 补丁 |
| 访问范围 | 只监听 `127.0.0.1` | 监听 `0.0.0.0:1984` |
| 密码 | 无 | Basic Auth + 登录 Cookie |
| 扫码助手 | 独立端口 `1985` | 只监听回环地址，由网关合并到 `1984` |
| 入口 | 桌面窗口 | 飞牛应用中心图标 |
| 进程管理 | Electron 看护 | fnOS `cmd/main` 生命周期 + systemd unit |

端口占用：

- `1984/tcp`：网页、API、WebRTC 信令、扫码助手（唯一需要对外开放的 HTTP 端口）
- `8555/tcp` + `8555/udp`：WebRTC 音视频
- 内部使用、不对外开放：`127.0.0.1:1985`（扫码助手）、`127.0.0.1:1986`（go2rtc API）、`127.0.0.1:8554`（RTSP）

## 构建

需要：

- Python 3.10+
- Go 1.21+（可以用 `--go` 指定路径）
- `patch`（Windows 上用 Git for Windows 自带的即可）
- 能访问 GitHub 和 Go 模块代理

```bash
# 在仓库根目录
python fpk/build.py --go /path/to/go
```

产物：

```text
fpk/dist/imi-lan_1.0.0_x86.fpk
fpk/dist/imi-lan_1.0.0_x86.fpk.sha256
```

构建脚本做了这些事：

1. 下载固定版本 go2rtc 1.9.15（校验 SHA-256），应用 `fpk/patches/xiaomi-login.patch`；
2. 交叉编译 `linux/amd64` 的 go2rtc 和 `fpk/gateway` 网关；
3. 把 `web/`、`qr-login.js`、两个二进制、图标和生命周期脚本打进 fpk；
4. 校验 `app.tgz` 的 MD5、ELF 架构和必要文件。

常用参数：

```bash
# 覆盖版本号
python fpk/build.py --go /path/to/go --version 1.0.1

# 把 Linux x86_64 版 ffmpeg 一起打进去（H.265 转码兜底）
python fpk/build.py --go /path/to/go --ffmpeg /path/to/ffmpeg
```

`fpk/build.py` 缓存源码和 Go 模块在 `fpk/.build/`；`fpk/dist/` 和 `.build/` 已在 `.gitignore` 里。

## 安装

1. 打开飞牛「应用中心 → 手动安装」，选择 `imi-lan_<版本>_x86.fpk`；
2. 向导里设置访问密码（至少 6 位）；
3. 应用会依赖并自动安装 `nodejs_v22`（扫码登录和房间信息需要）；
4. 安装完成后从桌面图标打开，或直接访问 `http://<飞牛地址>:1984`。

如果提示端口被占用，先确认飞牛上 `1984`、`8555` 没有被其他应用使用。

## 第一次使用

1. 浏览器提示登录时，用户名填 `imi`，密码填安装时设置的访问密码；
2. 点「登录并添加摄像头」；
3. 推荐「二维码登录」：用米家 App 右上角「＋ → 扫一扫」扫描页面上的二维码；
4. 扫码成功后助手会写入登录令牌并重启 go2rtc（画面会断开 1–2 秒），然后列出米家设备；
5. 勾选摄像头，点「添加选中摄像头」。

也可以用「账号密码」登录。如果小米账号开了两步验证，优先用扫码。

## 文件位置

| 内容 | 路径 |
| --- | --- |
| 程序与网页 | `/var/apps/imi-lan/target/` |
| go2rtc 配置、登录令牌、访问密码 | `$TRIM_PKGETC/`（通常是 `/volN/@appconf/imi-lan/`） |
| 运行日志、进程号 | `$TRIM_PKGVAR/`（通常是 `/volN/@appdata/imi-lan/`） |
| 服务脚本 | `/var/apps/imi-lan/cmd/main` |

`go2rtc.yaml`、`access.pass`、`access.secret` 都是敏感文件，不要外发。

## 修改密码 / 启停 / 卸载

- 修改密码：应用中心 → IMI-LAN → 设置 → 新的访问密码。留空表示不修改；修改后已登录的设备需要重新输入密码。
- 启停：应用中心的启动/停止按钮，或 `/var/apps/imi-lan/cmd/main start|stop|status`。
- 卸载：默认保留配置和登录令牌；卸载向导里可以勾选「清除所有配置和登录令牌」。重新安装后如果保留配置，不需要重新扫码。

## 常见问题

**浏览器一直弹登录框 / 密码错误**

访问密码在 `$TRIM_PKGETC/access.pass`，可以在应用设置里重设。改完会自动重启服务。

**页面能打开但没有画面**

- 先确认摄像头在米家 App 里在线，并且和飞牛在同一个局域网/网段；
- 打开应用日志：`$TRIM_PKGVAR/go2rtc.log` 和 `$TRIM_PKGVAR/gateway.log`；
- 同时拨号路数越多越容易抖动，先用 1×1 或 2×2。

**手机上看不到 H.265 主码流**

浏览器对 H.265 的支持不一致。可以：

- 在画面右上角切到「流畅」（通常走 H.264 子码流）；
- 或者构建时用 `--ffmpeg` 把 Linux ffmpeg 打进包，让 go2rtc 能转码兜底。

**扫码登录提示服务未启动**

确认 `nodejs_v22` 已安装，并且 `$TRIM_PKGVAR/qr-login.log` 里没有 `helper port ... unavailable` 之类的错误。扫码助手不可用时仍可以用账号密码登录。

**想把服务暴露到公网**

不建议直接把 `1984` 端口映射到公网。Basic Auth 走的是明文 HTTP；如果要外网访问，请在前面加 HTTPS 反向代理（例如飞牛自带的反代或 Caddy/Nginx），并只允许 HTTPS。

## 安全说明

- 网关只监听 `1984`，扫码助手和 go2rtc API 都只监听回环地址；
- 访问密码是唯一凭据：拿到密码的人可以打开网页，也可以通过 `/api/config` 读到 `go2rtc.yaml` 里的登录令牌。只把密码给信任的人；
- 访问密码只保存在 `$TRIM_PKGETC/access.pass`（权限 600），Cookie 用 `access.secret` 做 HMAC 签名；
- 修改密码会让旧 Cookie 失效；
- 摄像头音视频仍然只在飞牛和摄像头之间走局域网，不经过网关中转；
- 本项目不会上传画面，截图/录像只在浏览器本地生成。

如果构建时 Go 模块下载失败，可以显式指定代理：

```bash
GOPROXY=https://goproxy.cn,direct python fpk/build.py --go /path/to/go
```

## 已验证范围

- 已在本机用隔离端口验证：fpk 结构、静态页面、密码校验与 Cookie、`/api` 反代、WebSocket 代理、`/qr/new` 能正常获取二维码；
- 尚未在真实飞牛设备上执行「安装 → 启动 → 扫码 → 出画 → 卸载」全流程，首次安装时请留意应用日志。
