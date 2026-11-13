// imi-gateway：fnOS 版的单端口入口。
//
// 浏览器只访问 :1984：网关负责密码校验、网页静态文件、go2rtc API/WebSocket 反代，
// 以及把 /qr、/rooms 反代到只监听回环地址的二维码助手。
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const cookieName = "imi_auth"

var (
	username    string
	password    []byte
	cookieValue string
)

func readSecret(path string) []byte {
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Fatalf("read %s: %v", path, err)
	}
	return []byte(strings.TrimRight(string(raw), "\r\n"))
}

func cookieFor(user string, pass, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(user))
	mac.Write([]byte{0})
	mac.Write(pass)
	return "v1." + hex.EncodeToString(mac.Sum(nil))
}

func hasValidCookie(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	return err == nil && hmac.Equal([]byte(c.Value), []byte(cookieValue))
}

func validBasic(r *http.Request) bool {
	user, pass, ok := r.BasicAuth()
	if !ok {
		return false
	}
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(username))
	passOK := subtle.ConstantTimeCompare([]byte(pass), password)
	return userOK&passOK == 1
}

func isSecure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__imi/health" || r.URL.Path == "/__imi/logout" {
			next.ServeHTTP(w, r)
			return
		}
		if hasValidCookie(r) {
			next.ServeHTTP(w, r)
			return
		}
		if !validBasic(r) {
			w.Header().Set("WWW-Authenticate", `Basic realm="IMI-LAN", charset="UTF-8"`)
			http.Error(w, "需要访问密码", http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    cookieValue,
			Path:     "/",
			HttpOnly: true,
			Secure:   isSecure(r),
			SameSite: http.SameSiteLaxMode,
			MaxAge:   30 * 24 * 3600,
		})
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func tokenAuth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 健康检查不要求令牌，便于客户端启动阶段探测（也用于确认端口上是自己的网关）
		if r.URL.Path == "/health" || r.URL.Path == "/__imi/health" {
			next.ServeHTTP(w, r)
			return
		}
		got := ""
		if c, err := r.Cookie("imi_app"); err == nil {
			got = c.Value
		}
		if got == "" {
			got = r.Header.Get("X-IMI-Token")
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newProxy(raw string) *httputil.ReverseProxy {
	target, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("bad upstream %q: %v", raw, err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("upstream %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, "服务未启动或暂时不可用", http.StatusBadGateway)
	}
	return proxy
}

func main() {
	var (
		listen     = flag.String("listen", "0.0.0.0:1984", "listen address")
		staticDir  = flag.String("static", "", "web root directory")
		go2rtcAddr = flag.String("go2rtc", "http://127.0.0.1:1986", "go2rtc upstream")
		helperAddr = flag.String("helper", "http://127.0.0.1:1985", "qr-login helper upstream")
		user       = flag.String("user", "imi", "basic auth user")
		passFile   = flag.String("pass-file", "", "file containing the access password")
		secretFile = flag.String("secret-file", "", "file containing the cookie signing secret")
		noAuth     = flag.Bool("no-auth", false, "disable password auth (loopback/app mode)")
		appToken   = flag.String("app-token", "", "require this token in the imi_app cookie or X-IMI-Token header (app mode)")
		instanceID = flag.String("instance-id", "", "echo this id from /__imi/health so the app can tell its own gateway apart")
		enableQR   = flag.Bool("qr", false, "serve built-in QR login instead of proxying to the node helper")
		configPath = flag.String("config", "", "go2rtc.yaml path (required with -qr)")
		logDir     = flag.String("log-dir", "", "directory for qr-login.log (default: next to -config)")
	)
	flag.Parse()

	if *staticDir == "" {
		log.Fatal("-static is required")
	}
	if !*noAuth && (*passFile == "" || *secretFile == "") {
		log.Fatal("-pass-file and -secret-file are required unless -no-auth is set")
	}
	if *enableQR && *configPath == "" {
		log.Fatal("-config is required with -qr")
	}
	if _, err := os.Stat(filepath.Join(*staticDir, "index.html")); err != nil {
		log.Fatalf("static dir %s: %v", *staticDir, err)
	}

	username = *user
	if !*noAuth {
		password = readSecret(*passFile)
		if len(password) == 0 {
			log.Fatal("access password is empty")
		}
		secret := readSecret(*secretFile)
		if len(secret) == 0 {
			log.Fatal("cookie secret is empty")
		}
		cookieValue = cookieFor(username, password, secret)
	}

	go2rtcProxy := newProxy(*go2rtcAddr)
	helperProxy := newProxy(*helperAddr)

	static := http.FileServer(http.Dir(*staticDir))
	staticHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/__imi/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "service": "imi-gateway", "instance": *instanceID,
		})
	})
	mux.HandleFunc("/__imi/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			Secure:   isSecure(r),
			SameSite: http.SameSiteLaxMode,
			MaxAge:   -1,
		})
		w.Header().Set("WWW-Authenticate", `Basic realm="IMI-LAN", charset="UTF-8"`)
		http.Error(w, "已退出，重新打开页面需要输入密码", http.StatusUnauthorized)
	})
	mux.Handle("/api", go2rtcProxy)
	mux.Handle("/api/", go2rtcProxy)
	if *enableQR {
		qrLog := *logDir
		if qrLog == "" {
			qrLog = filepath.Dir(*configPath)
		}
		qr := newQRService(*configPath, *go2rtcAddr, filepath.Join(qrLog, "qr-login.log"))
		qr.register(mux)
	} else {
		mux.Handle("/qr", helperProxy)
		mux.Handle("/qr/", helperProxy)
		mux.Handle("/rooms", helperProxy)
	}
	mux.Handle("/", staticHandler)

	handler := http.Handler(mux)
	if !*noAuth {
		handler = auth(handler)
	}
	if *appToken != "" {
		handler = tokenAuth(*appToken, handler)
	}
	handler = securityHeaders(handler)

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       5 * time.Minute,
	}

	// 先绑定端口再打日志，端口被占用时立即退出，方便 App 识别启动失败。
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("listen %s: %v", *listen, err)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	log.Printf("imi-gateway listening on %s (go2rtc=%s helper=%s)", *listen, *go2rtcAddr, *helperAddr)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
