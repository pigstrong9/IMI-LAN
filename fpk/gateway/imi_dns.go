// IMI_DNS：Android 上没有 /etc/resolv.conf，纯 Go 解析器拿不到系统 DNS。
//
// 安卓客户端会把系统当前的 DNS 服务器地址通过 IMI_DNS 传给网关，这里把它
// 设为默认解析器。桌面版 / NAS 版不设置该变量，行为完全不变。
package main

import (
	"context"
	"net"
	"os"
	"strings"
	"time"
)

func init() {
	server := strings.TrimSpace(os.Getenv("IMI_DNS"))
	if server == "" {
		return
	}
	addr := net.JoinHostPort(server, "53")
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(ctx, network, addr)
		},
	}
}
