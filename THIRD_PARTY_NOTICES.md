# 第三方组件与参考实现

本项目的原创部分（`web/`、`qr-login.js`、启动脚本）未指定单独许可证。
下面列出捆绑或参考的第三方项目及其许可证。

## go2rtc（MIT）

- 项目：https://github.com/AlexxIT/go2rtc
- 使用方式：捆绑 `go2rtc.exe`；`web/video-rtc.js` 来自其 MIT 许可的播放器。
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
