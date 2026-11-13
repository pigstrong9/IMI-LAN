// go2rtc 网关内置的米家二维码登录助手（移植自 qr-login.js）。
//
// 与 qr-login.js 的行为保持一致：
//  1. 向 account.xiaomi.com 申请二维码并长轮询扫码结果；
//  2. 把扫码那一刻的完整云端凭据（serviceToken/ssecurity/cUserId/passToken）
//     写回 go2rtc.yaml 的 xiaomi-credentials 段，passToken 另存 xiaomi: 段；
//  3. 通过 go2rtc 的 /api/restart 重启引擎；
//  4. /rooms 只做只读云端查询，结果只回给本机网页。
//
// 安卓版需要这一段是因为手机上无法运行 Node。fnOS 版仍可使用原来的
// qr-login.js，或用 -qr 切换到本实现（两者二选一）。
package main

import (
	"crypto/rand"
	"crypto/rc4"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const qrUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

var (
	reXiaomiHeader = regexp.MustCompile(`^xiaomi:\s*(?:#.*)?$`)
	reCredHeader   = regexp.MustCompile(`^xiaomi-credentials:\s*(?:#.*)?$`)
	reTopLevelLine = regexp.MustCompile(`^\S`)
	reFlatEntry    = regexp.MustCompile(`^\s+("[^"]+"|[^:\s]+)\s*:\s*(.*?)\s*$`)
	reNestedEntry  = regexp.MustCompile(`^\s+("[^"]+"|[^:\s]+)\s*:\s*(\{.*\})\s*$`)
	reStreamsLine  = regexp.MustCompile(`^streams:\s*$`)
)

// ---------------------------------------------------------------- 服务主体

type qrService struct {
	configPath string
	apiBase    string
	logPath    string

	sessionMu sync.Mutex
	session   *qrSession

	locks sync.Map // key -> *sync.Mutex，防止同一账号并发登录

	roomsMu   sync.Mutex
	roomsKey  string
	roomsAt   time.Time
	roomsData *roomsData
	roomsFail string
	roomsFailAt time.Time

	authKey   string
	authAt    time.Time
	auth      *cloudAuth
	authToken string
}

func newQRService(configPath, apiBase, logPath string) *qrService {
	return &qrService{configPath: configPath, apiBase: strings.TrimRight(apiBase, "/"), logPath: logPath}
}

func (s *qrService) infof(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("[qr] %s", msg)
	if s.logPath == "" {
		return
	}
	if st, err := os.Stat(s.logPath); err == nil && st.Size() > 512*1024 {
		_ = os.Rename(s.logPath, s.logPath+".1")
	}
	f, err := os.OpenFile(s.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	stamp := time.Now().Format("2006/01/02 15:04:05")
	_, _ = f.WriteString("[" + stamp + "] " + msg + "\n")
}

func (s *qrService) withLock(key string, fn func()) {
	v, _ := s.locks.LoadOrStore(key, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	fn()
}

// ---------------------------------------------------------------- HTTP 会话

type httpSession struct {
	cookies map[string]string
	client  *http.Client
}

func newHTTPSession() *httpSession {
	return &httpSession{
		cookies: map[string]string{},
		client: &http.Client{
			Timeout: 25 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (s *httpSession) cookieHeader() string {
	parts := make([]string, 0, len(s.cookies))
	for k, v := range s.cookies {
		parts = append(parts, k+"="+v)
	}
	sort.Strings(parts)
	return strings.Join(parts, "; ")
}

func (s *httpSession) store(res *http.Response) {
	for _, c := range res.Cookies() {
		if strings.EqualFold(c.Value, "EXPIRED") {
			delete(s.cookies, c.Name)
			continue
		}
		s.cookies[c.Name] = c.Value
	}
}

func (s *httpSession) realCookie(name string) string {
	v := s.cookies[name]
	if v == "" || strings.EqualFold(v, "EXPIRED") {
		return ""
	}
	return v
}

func (s *httpSession) request(rawurl string) (*http.Response, error) {
	req, err := http.NewRequest("GET", rawurl, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", qrUserAgent)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	if c := s.cookieHeader(); c != "" {
		req.Header.Set("Cookie", c)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	s.store(res)
	return res, nil
}

func (s *httpSession) requestFollow(rawurl string) (*http.Response, error) {
	current := rawurl
	var res *http.Response
	for i := 0; i < 6; i++ {
		r, err := s.request(current)
		if err != nil {
			return nil, err
		}
		res = r
		if r.StatusCode >= 300 && r.StatusCode < 400 {
			_, _ = io.Copy(io.Discard, r.Body)
			_ = r.Body.Close()
			next, err := r.Location()
			if err != nil || next == nil {
				return r, nil
			}
			current = next.String()
			continue
		}
		return r, nil
	}
	return res, nil
}

func parseJSONP(text string) (map[string]any, error) {
	const mark = "&&&START&&&"
	if i := strings.Index(text, mark); i >= 0 {
		text = text[i+len(mark):]
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &out); err != nil {
		return nil, err
	}
	return out, nil
}

func strOf(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case json.Number:
		return t.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(t)
	}
}

func maskUID(uid string) string {
	if len(uid) > 4 {
		return uid[:2] + "****" + uid[len(uid)-2:]
	}
	return "****"
}

func safeHost(rawurl string) string {
	u, err := url.Parse(rawurl)
	if err != nil {
		return "(bad url)"
	}
	return u.Host + u.Path
}

// ---------------------------------------------------------------- 二维码会话

type credential struct {
	PassToken    string
	ServiceToken string
	CUserID      string
	SSecurity    string
}

type qrSession struct {
	sid string
	*httpSession

	mu       sync.Mutex
	state    string
	message  string
	user     string
	expires  time.Time
	canceled bool
	lp       string
	image    []byte
}

func newQRSession() *qrSession {
	sid := make([]byte, 8)
	_, _ = rand.Read(sid)
	return &qrSession{
		sid:         hex.EncodeToString(sid),
		httpSession: newHTTPSession(),
		state:       "starting",
	}
}

func (q *qrSession) snapshot() map[string]any {
	q.mu.Lock()
	defer q.mu.Unlock()
	user := q.user
	if q.state != "done" {
		user = maskUID(user)
	}
	expiresIn := 0
	if !q.expires.IsZero() {
		left := int(time.Until(q.expires).Seconds())
		if left < 0 {
			left = 0
		}
		expiresIn = left
	}
	return map[string]any{
		"state":     q.state,
		"user":      user,
		"message":   q.message,
		"expiresIn": expiresIn,
	}
}

func (q *qrSession) setState(state, message string) {
	q.mu.Lock()
	q.state = state
	q.message = message
	q.mu.Unlock()
}

func (q *qrSession) cancel() {
	q.mu.Lock()
	q.canceled = true
	if q.state != "done" {
		q.state = "canceled"
		q.message = "已取消"
	}
	q.mu.Unlock()
}

func (q *qrSession) isCanceled() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.canceled
}

func (q *qrSession) start(s *qrService) error {
	params := url.Values{}
	params.Set("_qrsize", "480")
	params.Set("qs", "%3Fsid%3Dxiaomiio%26_json%3Dtrue")
	params.Set("callback", "https://sts.api.io.mi.com/sts")
	params.Set("_hasLogo", "false")
	params.Set("sid", "xiaomiio")
	params.Set("serviceParam", "")
	params.Set("_locale", "zh_CN")
	params.Set("_dc", strconv.FormatInt(time.Now().UnixMilli(), 10))
	loginURL := "https://account.xiaomi.com/longPolling/loginUrl?" + params.Encode()

	res, err := q.requestFollow(loginURL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	ticket, err := parseJSONP(string(body))
	if err != nil {
		return fmt.Errorf("loginUrl 响应无法解析: %w", err)
	}
	if code := strOf(ticket["code"]); code != "" && code != "0" {
		return fmt.Errorf("loginUrl code=%s", code)
	}
	q.lp = strOf(ticket["lp"])
	if q.lp == "" {
		return errors.New("loginUrl 未返回长轮询地址")
	}
	timeout := 300
	if n, err := strconv.Atoi(strOf(ticket["timeout"])); err == nil && n > 0 {
		timeout = n
	}
	qrURL := strOf(ticket["qr"])
	if qrURL == "" {
		return errors.New("loginUrl 未返回二维码地址")
	}
	imgRes, err := q.requestFollow(qrURL)
	if err != nil {
		return err
	}
	defer imgRes.Body.Close()
	img, err := io.ReadAll(io.LimitReader(imgRes.Body, 4<<20))
	if err != nil {
		return err
	}
	if len(img) == 0 {
		return errors.New("二维码图片为空")
	}

	q.mu.Lock()
	q.image = img
	q.state = "waiting"
	q.message = "等待扫码"
	q.expires = time.Now().Add(time.Duration(timeout) * time.Second)
	q.mu.Unlock()

	go q.waitScan(s)
	return nil
}

func (q *qrSession) waitScan(s *qrService) {
	for {
		q.mu.Lock()
		expires := q.expires
		lp := q.lp
		q.mu.Unlock()

		if q.isCanceled() {
			return
		}
		if time.Now().After(expires) {
			q.setState("expired", "二维码已过期")
			return
		}
		if lp == "" {
			time.Sleep(time.Second)
			continue
		}
		res, err := q.requestFollow(lp)
		if err == nil && res != nil {
			body, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				if data, perr := parseJSONP(string(body)); perr == nil {
					if strOf(data["location"]) != "" && strOf(data["userId"]) != "" {
						q.handleScan(s, data)
						return
					}
				}
			}
		}
		time.Sleep(time.Second)
	}
}

func (q *qrSession) handleScan(s *qrService, data map[string]any) {
	if q.isCanceled() {
		q.setState("canceled", "已取消")
		return
	}
	user := strOf(data["userId"])
	q.mu.Lock()
	q.user = user
	q.state = "scanned"
	q.message = "已扫码，请在手机上确认"
	q.mu.Unlock()
	s.infof("scanned by %s", maskUID(user))

	// 把整条 location 链走到头：sts 那一跳会签发 serviceToken（Cookie）
	// 和 ssecurity（Extension-Pragma 头）。
	loc := strOf(data["location"])
	ssecurity := ""
	for i := 0; i < 12 && loc != ""; i++ {
		res, err := q.request(loc)
		var next string
		if err == nil && res != nil {
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()
			if ext := res.Header.Get("Extension-Pragma"); ext != "" {
				var pragma struct {
					SSecurity string `json:"ssecurity"`
				}
				if json.Unmarshal([]byte(ext), &pragma) == nil && pragma.SSecurity != "" {
					ssecurity = pragma.SSecurity
				}
			}
			if l, lerr := res.Location(); lerr == nil && l != nil {
				next = l.String()
			}
			s.infof("login hop %d: %s -> %d serviceToken=%v ssecurity=%v",
				i+1, safeHost(loc), res.StatusCode,
				q.realCookie("serviceToken") != "", ssecurity != "")
		}
		if next == "" {
			break
		}
		loc = next
	}

	cred := credential{
		PassToken:    q.realCookie("passToken"),
		ServiceToken: q.realCookie("serviceToken"),
		CUserID:      q.realCookie("cUserId"),
		SSecurity:    ssecurity,
	}

	// 兜底：链上没给 ssecurity 时，用刚扫到的 passToken 走一次完整
	// serviceLogin（与引擎 LoginWithToken 相同的 userId+passToken 形态）。
	if cred.PassToken != "" && cred.SSecurity == "" {
		if auth, err := cloudLogin(user, cred.PassToken); err == nil {
			cred.SSecurity = base64.StdEncoding.EncodeToString(auth.ssecurity)
			for _, name := range []string{"cUserId", "serviceToken"} {
				if v := auth.session.realCookie(name); v != "" {
					q.cookies[name] = v
				}
			}
			if np := auth.session.realCookie("passToken"); np != "" {
				q.cookies["passToken"] = np
			}
			cred = credential{
				PassToken:    q.realCookie("passToken"),
				ServiceToken: q.realCookie("serviceToken"),
				CUserID:      q.realCookie("cUserId"),
				SSecurity:    cred.SSecurity,
			}
			s.infof("credentials completed via serviceLogin")
		} else {
			s.infof("serviceLogin fallback failed: %v", err)
		}
	}

	if cred.PassToken == "" {
		q.setState("error", "登录成功但没拿到 passToken，请重试")
		s.infof("missing passToken for %s", maskUID(user))
		return
	}
	if q.isCanceled() {
		q.setState("canceled", "已取消")
		return
	}

	complete := cred.ServiceToken != "" && cred.SSecurity != ""
	if !complete {
		s.infof("incomplete credentials for %s: serviceToken=%v ssecurity=%v",
			maskUID(user), cred.ServiceToken != "", cred.SSecurity != "")
	}

	q.setState("restarting", "登录成功，正在重启引擎")
	if err := s.saveToken(user, cred); err != nil {
		q.setState("error", "写入 go2rtc.yaml 失败："+err.Error())
		s.infof("save token failed: %v", err)
		return
	}
	if !s.restartEngine() {
		q.setState("error", "token 已保存，但引擎重启失败，请重启 IMI-LAN 应用")
		return
	}
	if complete {
		q.setState("done", "登录成功")
	} else {
		q.setState("done", "登录成功（云端会话不完整，已用兼容模式保存）")
	}
}

// ---------------------------------------------------------------- 配置读写

func splitConfig(text string) (lines []string, eol string) {
	text = strings.TrimPrefix(text, "\ufeff")
	if strings.Contains(text, "\r\n") {
		eol = "\r\n"
	} else {
		eol = "\n"
	}
	return strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n"), eol
}

func blockRange(lines []string, header *regexp.Regexp) (int, int, bool) {
	start := -1
	for i, l := range lines {
		if header.MatchString(l) {
			start = i
			break
		}
	}
	if start < 0 {
		return 0, 0, false
	}
	end := len(lines)
	for j := start + 1; j < len(lines); j++ {
		if reTopLevelLine.MatchString(lines[j]) {
			end = j
			break
		}
	}
	return start, end, true
}

func unquoteYAML(v string) string {
	if len(v) >= 2 && v[0] == '"' && strings.HasSuffix(v, `"`) {
		var out string
		if json.Unmarshal([]byte(v), &out) == nil {
			return out
		}
		return v[1 : len(v)-1]
	}
	return v
}

func jsonStr(v string) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `""`
	}
	return string(b)
}

func insertTopLevel(lines []string, header, entry string) []string {
	idx := len(lines)
	for i, l := range lines {
		if reStreamsLine.MatchString(l) {
			idx = i
			break
		}
	}
	block := []string{header, entry}
	if idx < len(lines) {
		block = append(block, "")
	}
	out := make([]string, 0, len(lines)+len(block))
	out = append(out, lines[:idx]...)
	out = append(out, block...)
	out = append(out, lines[idx:]...)
	return out
}

func upsertFlatEntry(lines []string, header *regexp.Regexp, user, value string) ([]string, bool) {
	start, end, ok := blockRange(lines, header)
	if !ok {
		return lines, false
	}
	order := []string{}
	entries := map[string]string{}
	for _, l := range lines[start+1 : end] {
		m := reFlatEntry.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		v := strings.TrimSpace(m[2])
		if strings.HasPrefix(v, "{") {
			continue
		}
		key := unquoteYAML(m[1])
		if _, seen := entries[key]; !seen {
			order = append(order, key)
		}
		entries[key] = unquoteYAML(v)
	}
	if _, seen := entries[user]; !seen {
		order = append(order, user)
	}
	entries[user] = value

	block := []string{lines[start]}
	for _, k := range order {
		block = append(block, "  "+jsonStr(k)+": "+jsonStr(entries[k]))
	}
	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, block...)
	out = append(out, lines[end:]...)
	return out, true
}

type credFields struct {
	ServiceToken string
	SSecurity    string
	CUserID      string
	PassToken    string
}

func (c credFields) json() string {
	return `{"serviceToken":` + jsonStr(c.ServiceToken) +
		`,"ssecurity":` + jsonStr(c.SSecurity) +
		`,"cUserId":` + jsonStr(c.CUserID) +
		`,"passToken":` + jsonStr(c.PassToken) + `}`
}

func parseCredFields(raw string) (credFields, bool) {
	var m map[string]string
	if json.Unmarshal([]byte(raw), &m) != nil {
		return credFields{}, false
	}
	return credFields{
		ServiceToken: m["serviceToken"],
		SSecurity:    m["ssecurity"],
		CUserID:      m["cUserId"],
		PassToken:    m["passToken"],
	}, true
}

func upsertNestedEntry(lines []string, header *regexp.Regexp, user string, fields credFields) ([]string, bool) {
	start, end, ok := blockRange(lines, header)
	if !ok {
		return lines, false
	}
	order := []string{}
	values := map[string]string{}
	for _, l := range lines[start+1 : end] {
		m := reNestedEntry.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		key := unquoteYAML(m[1])
		if _, seen := values[key]; !seen {
			order = append(order, key)
		}
		if parsed, ok := parseCredFields(m[2]); ok {
			values[key] = parsed.json()
		} else {
			values[key] = m[2]
		}
	}
	if _, seen := values[user]; !seen {
		order = append(order, user)
	}
	values[user] = fields.json()

	block := []string{lines[start]}
	for _, k := range order {
		block = append(block, "  "+jsonStr(k)+": "+values[k])
	}
	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, block...)
	out = append(out, lines[end:]...)
	return out, true
}

func removeNestedEntry(lines []string, header *regexp.Regexp, user string) []string {
	start, end, ok := blockRange(lines, header)
	if !ok {
		return lines
	}
	order := []string{}
	values := map[string]string{}
	for _, l := range lines[start+1 : end] {
		m := reNestedEntry.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		key := unquoteYAML(m[1])
		if key == user {
			continue
		}
		if _, seen := values[key]; !seen {
			order = append(order, key)
		}
		values[key] = m[2]
	}
	block := []string{}
	for _, k := range order {
		block = append(block, "  "+jsonStr(k)+": "+values[k])
	}
	if len(block) > 0 {
		block = append([]string{lines[start]}, block...)
	}
	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, block...)
	out = append(out, lines[end:]...)
	return out
}

func (s *qrService) writeConfig(lines []string, eol string) error {
	tmp := s.configPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(lines, eol)), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.configPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(s.configPath, 0o600)
	return nil
}

func (s *qrService) saveToken(user string, cred credential) error {
	original, err := os.ReadFile(s.configPath)
	if err != nil {
		return err
	}
	_ = os.WriteFile(s.configPath+".bak", original, 0o600)

	lines, eol := splitConfig(string(original))
	if next, ok := upsertFlatEntry(lines, reXiaomiHeader, user, cred.PassToken); ok {
		lines = next
	} else {
		lines = insertTopLevel(lines, "xiaomi:", "  "+jsonStr(user)+": "+jsonStr(cred.PassToken))
	}
	if cred.ServiceToken != "" && cred.SSecurity != "" {
		fields := credFields{
			ServiceToken: cred.ServiceToken,
			SSecurity:    cred.SSecurity,
			CUserID:      cred.CUserID,
			PassToken:    cred.PassToken,
		}
		if next, ok := upsertNestedEntry(lines, reCredHeader, user, fields); ok {
			lines = next
		} else {
			lines = insertTopLevel(lines, "xiaomi-credentials:", "  "+jsonStr(user)+": "+fields.json())
		}
	} else {
		lines = removeNestedEntry(lines, reCredHeader, user)
	}
	if err := s.writeConfig(lines, eol); err != nil {
		return err
	}
	s.roomsMu.Lock()
	s.roomsKey, s.roomsData, s.roomsFail = "", nil, ""
	s.roomsMu.Unlock()
	s.authKey, s.auth, s.authToken, s.authAt = "", nil, "", time.Time{}
	s.infof("token saved for %s", maskUID(user))
	return nil
}

func (s *qrService) readCredentials() map[string]credFields {
	out := map[string]credFields{}
	raw, err := os.ReadFile(s.configPath)
	if err != nil {
		return out
	}
	lines, _ := splitConfig(string(raw))
	start, end, ok := blockRange(lines, reCredHeader)
	if !ok {
		return out
	}
	for _, l := range lines[start+1 : end] {
		m := reFlatEntry.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		fields, ok := parseCredFields(strings.TrimSpace(m[2]))
		if ok && fields.ServiceToken != "" && fields.SSecurity != "" {
			out[unquoteYAML(m[1])] = fields
		}
	}
	return out
}

func (s *qrService) readXiaomiTokens() map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(s.configPath)
	if err != nil {
		return out
	}
	lines, _ := splitConfig(string(raw))
	start, end, ok := blockRange(lines, reXiaomiHeader)
	if !ok {
		return out
	}
	for _, l := range lines[start+1 : end] {
		m := reFlatEntry.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		value := unquoteYAML(strings.TrimSpace(m[2]))
		if value != "" {
			out[unquoteYAML(m[1])] = value
		}
	}
	return out
}

// persistRefreshedToken 把轮换后的 passToken 写回配置。
func (s *qrService) persistRefreshedToken(user, configToken string, auth *cloudAuth, authToken string) {
	if authToken != configToken {
		return
	}
	next := auth.session.realCookie("passToken")
	if next == "" || next == configToken {
		return
	}
	if s.readXiaomiTokens()[user] != configToken {
		return
	}
	raw, err := os.ReadFile(s.configPath)
	if err != nil {
		return
	}
	lines, eol := splitConfig(string(raw))
	start, end, ok := blockRange(lines, reXiaomiHeader)
	if !ok {
		return
	}
	order := []string{}
	entries := map[string]string{}
	for _, l := range lines[start+1 : end] {
		m := reFlatEntry.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		key := unquoteYAML(m[1])
		if _, seen := entries[key]; !seen {
			order = append(order, key)
		}
		entries[key] = unquoteYAML(strings.TrimSpace(m[2]))
	}
	if _, seen := entries[user]; !seen {
		order = append(order, user)
	}
	entries[user] = next
	block := []string{"xiaomi:"}
	for _, k := range order {
		block = append(block, "  "+jsonStr(k)+": "+jsonStr(entries[k]))
	}
	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, block...)
	out = append(out, lines[end:]...)
	if err := s.writeConfig(out, eol); err != nil {
		s.infof("token refresh failed: %v", err)
		return
	}
	s.infof("token refreshed for %s", maskUID(user))
}

// ---------------------------------------------------------------- 小米云端

type cloudAuth struct {
	session  *httpSession
	ssecurity []byte
}

func cloudLogin(user, token string) (*cloudAuth, error) {
	session := newHTTPSession()
	session.cookies["userId"] = user
	session.cookies["passToken"] = token

	res, err := session.requestFollow("https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio")
	if err != nil {
		return nil, err
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	data, err := parseJSONP(string(body))
	if err != nil {
		return nil, err
	}
	if strOf(data["code"]) == "70016" {
		return nil, errors.New("小米账号需要验证，请稍后重试或重新扫码")
	}
	location := strOf(data["location"])
	if location == "" {
		return nil, errors.New("登录令牌已失效，请重新扫码")
	}
	ssecurity, err := base64.StdEncoding.DecodeString(strOf(data["ssecurity"]))
	if err != nil || len(ssecurity) == 0 {
		return nil, errors.New("小米云端未返回 ssecurity")
	}
	if res, err = session.requestFollow(location); err != nil {
		return nil, err
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	for _, name := range []string{"userId", "cUserId", "serviceToken"} {
		if session.realCookie(name) == "" {
			return nil, errors.New("小米云端登录不完整")
		}
	}
	return &cloudAuth{session: session, ssecurity: ssecurity}, nil
}

var cloudHosts = map[string]string{
	"cn": "https://api.io.mi.com/app",
	"de": "https://de.api.io.mi.com/app",
	"i2": "https://i2.api.io.mi.com/app",
	"ru": "https://ru.api.io.mi.com/app",
	"sg": "https://sg.api.io.mi.com/app",
	"us": "https://us.api.io.mi.com/app",
}

func rc4Crypt(key, in []byte) []byte {
	c, err := rc4.NewCipher(key)
	if err != nil {
		return nil
	}
	// go2rtc 的 RC4 实现会先丢弃 1024 字节
	drop := make([]byte, 1024)
	c.XORKeyStream(drop, drop)
	out := make([]byte, len(in))
	c.XORKeyStream(out, in)
	return out
}

func signedNonceOf(ssecurity, nonce []byte) []byte {
	h := sha256.New()
	h.Write(ssecurity)
	h.Write(nonce)
	return h.Sum(nil)
}

func signatureOf(method, apiPath, data, rc4hash string, hasHash bool, signedNonce []byte) string {
	text := method + "&" + apiPath + "&data=" + data
	if hasHash {
		text += "&rc4_hash__=" + rc4hash
	}
	text += "&" + base64.StdEncoding.EncodeToString(signedNonce)
	sum := sha1.Sum([]byte(text))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func cloudRequest(auth *cloudAuth, region, apiPath string, body any) (map[string]any, error) {
	base := cloudHosts[region]
	if base == "" {
		base = cloudHosts["cn"]
	}
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	n := big.NewInt(time.Now().Unix() / 60)
	b := n.Bytes()
	if len(b) > 4 {
		b = b[len(b)-4:]
	}
	copy(nonce[8:], b) // 后 4 字节 = 分钟数（大端）
	signedNonce := signedNonceOf(auth.ssecurity, nonce)

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	data := string(payload)
	hash := signatureOf("POST", apiPath, data, "", false, signedNonce)
	dataEnc := base64.StdEncoding.EncodeToString(rc4Crypt(signedNonce, []byte(data)))
	hashEnc := base64.StdEncoding.EncodeToString(rc4Crypt(signedNonce, []byte(hash)))
	signature := signatureOf("POST", apiPath, dataEnc, hashEnc, true, signedNonce)
	nonceEnc := base64.StdEncoding.EncodeToString(nonce)

	form := "data=" + url.QueryEscape(dataEnc) +
		"&rc4_hash__=" + url.QueryEscape(hashEnc) +
		"&signature=" + url.QueryEscape(signature) +
		"&_nonce=" + url.QueryEscape(nonceEnc)

	req, err := http.NewRequest("POST", base+apiPath, strings.NewReader(form))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", randomAppUA())
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Cookie", "userId="+auth.session.realCookie("userId")+
		"; cUserId="+auth.session.realCookie("cUserId")+
		"; serviceToken="+auth.session.realCookie("serviceToken"))

	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("小米云端 HTTP %d", res.StatusCode)
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	enc, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, err
	}
	plain := rc4Crypt(signedNonce, enc)
	var data2 struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Result  json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(plain, &data2); err != nil {
		return nil, err
	}
	if data2.Code != 0 {
		if data2.Message != "" {
			return nil, errors.New(data2.Message)
		}
		return nil, fmt.Errorf("小米云端错误 %d", data2.Code)
	}
	var result map[string]any
	if len(data2.Result) > 0 {
		if err := json.Unmarshal(data2.Result, &result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func randomAppUA() string {
	const lower = "abcdefghijklmnopqrstuvwxyz"
	const upper = "ABCDE"
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	prefix := make([]byte, 18)
	for i := range prefix {
		prefix[i] = lower[int(buf[i])%len(lower)]
	}
	suffix := make([]byte, 13)
	for i := range suffix {
		suffix[i] = upper[int(buf[i+18])%len(upper)]
	}
	return string(prefix) + "-" + string(suffix) + " APP/com.xiaomi.mihome APPV/10.5.201"
}

// authFromCredentials 有完整凭据时直接构造会话，不请求 account.xiaomi.com。
func (s *qrService) authFromCredentials(user string) *cloudAuth {
	cred, ok := s.readCredentials()[user]
	if !ok {
		return nil
	}
	ssecurity, err := base64.StdEncoding.DecodeString(cred.SSecurity)
	if err != nil || len(ssecurity) == 0 || cred.ServiceToken == "" {
		return nil
	}
	session := newHTTPSession()
	session.cookies["userId"] = user
	if cred.CUserID != "" {
		session.cookies["cUserId"] = cred.CUserID
	}
	session.cookies["serviceToken"] = cred.ServiceToken
	return &cloudAuth{session: session, ssecurity: ssecurity}
}

// getAuth 返回账号的云端会话；同一账号的登录只跑一次。
func (s *qrService) getAuth(user, token string, force bool) (*cloudAuth, string, error) {
	if force && s.authKey == user {
		s.authKey, s.auth, s.authToken, s.authAt = "", nil, "", time.Time{}
	}
	var auth *cloudAuth
	var authToken string
	var authErr error
	s.withLock("login:"+user, func() {
		if s.auth != nil && s.authKey == user && time.Since(s.authAt) < 10*time.Minute {
			auth, authToken = s.auth, s.authToken
			return
		}
		if direct := s.authFromCredentials(user); direct != nil {
			configToken := s.readXiaomiTokens()[user]
			if configToken == "" {
				configToken = token
			}
			s.authKey, s.authAt, s.auth, s.authToken = user, time.Now(), direct, configToken
			auth, authToken = direct, configToken
			return
		}
		logged, err := cloudLogin(user, token)
		if err != nil {
			authErr = err
			return
		}
		s.authKey, s.authAt, s.auth, s.authToken = user, time.Now(), logged, token
		auth, authToken = logged, token
	})
	return auth, authToken, authErr
}

// ---------------------------------------------------------------- 房间信息

type roomInfo struct {
	Name   string `json:"name"`
	Online int    `json:"online"`
	Total  int    `json:"total"`
}

type deviceInfo struct {
	DID    string `json:"did"`
	Room   string `json:"room"`
	Online bool   `json:"online"`
}

type totalInfo struct {
	Online int `json:"online"`
	Total  int `json:"total"`
}

type roomsData struct {
	OK        bool         `json:"ok"`
	Rooms     []roomInfo   `json:"rooms"`
	Devices   []deviceInfo `json:"devices"`
	Total     totalInfo    `json:"total"`
	UpdatedAt int64        `json:"updatedAt"`
}

func (s *qrService) fetchRooms(user, region string) (*roomsData, error) {
	key := user + "|" + region
	s.roomsMu.Lock()
	if s.roomsData != nil && s.roomsKey == key && time.Since(s.roomsAt) < 10*time.Minute {
		data := s.roomsData
		s.roomsMu.Unlock()
		return data, nil
	}
	if s.roomsFail != "" && s.roomsKey == key && time.Since(s.roomsFailAt) < 3*time.Minute {
		msg := s.roomsFail
		s.roomsMu.Unlock()
		return nil, errors.New(msg)
	}
	s.roomsMu.Unlock()

	var result *roomsData
	var resultErr error
	s.withLock("rooms:"+key, func() {
		result, resultErr = s.loadRooms(user, region, key)
	})
	return result, resultErr
}

func (s *qrService) loadRooms(user, region, key string) (*roomsData, error) {
	fail := func(err error) (*roomsData, error) {
		s.roomsMu.Lock()
		s.roomsFail, s.roomsFailAt, s.roomsKey = err.Error(), time.Now(), key
		s.roomsMu.Unlock()
		return nil, err
	}

	token := s.readXiaomiTokens()[user]
	if token == "" {
		return fail(errors.New("没有可用的登录令牌"))
	}
	direct := s.authFromCredentials(user)
	auth, authToken, err := s.getAuth(user, token, false)
	if err != nil {
		return fail(err)
	}
	if auth == nil {
		return fail(errors.New("小米账号登录失败，请重新扫码"))
	}
	s.persistRefreshedToken(user, token, auth, authToken)

	homeBody := map[string]any{
		"limit": 150, "fetch_share": true, "fetch_share_dev": true,
		"plat_form": 0, "app_ver": 9,
	}
	home, err := cloudRequest(auth, region, "/v2/homeroom/gethome", homeBody)
	if err != nil {
		if !strings.Contains(err.Error(), "HTTP 401") {
			return fail(err)
		}
		if direct != nil {
			return fail(errors.New("登录已失效，请重新扫码"))
		}
		auth, authToken, err = s.getAuth(user, token, true)
		if err != nil {
			return fail(err)
		}
		if auth == nil {
			return fail(errors.New("小米账号登录失败，请重新扫码"))
		}
		s.persistRefreshedToken(user, token, auth, authToken)
		home, err = cloudRequest(auth, region, "/v2/homeroom/gethome", homeBody)
		if err != nil {
			return fail(err)
		}
	}

	roomOf := map[string]string{}
	dids := []string{}
	seenDID := map[string]bool{}
	appendHome := func(list []any) {
		for _, item := range list {
			h, ok := item.(map[string]any)
			if !ok {
				continue
			}
			rooms, _ := h["roomlist"].([]any)
			for _, r := range rooms {
				room, ok := r.(map[string]any)
				if !ok {
					continue
				}
				name := strOf(room["name"])
				if name == "" {
					name = "未分配房间"
				}
				roomDIDs, _ := room["dids"].([]any)
				for _, d := range roomDIDs {
					did := strOf(d)
					if did == "" {
						continue
					}
					if _, ok := roomOf[did]; !ok {
						roomOf[did] = name
					}
					if !seenDID[did] {
						seenDID[did] = true
						dids = append(dids, did)
					}
				}
			}
		}
	}
	if list, ok := home["homelist"].([]any); ok {
		appendHome(list)
	}
	if list, ok := home["share_home_list"].([]any); ok {
		appendHome(list)
	}

	devicesResult, err := cloudRequest(auth, region, "/v2/home/device_list_page", map[string]any{
		"limit": 200, "get_split_device": true, "get_third_device": true, "dids": dids,
	})
	if err != nil {
		return fail(err)
	}

	reCameraModel := regexp.MustCompile(`(?i)\.(camera|cateye|feeder)\.`)
	devices := []deviceInfo{}
	roomMap := map[string]*roomInfo{}
	roomOrder := []string{}
	list, _ := devicesResult["list"].([]any)
	for _, item := range list {
		d, ok := item.(map[string]any)
		if !ok {
			continue
		}
		did := strOf(d["did"])
		if did == "" || !reCameraModel.MatchString(strOf(d["model"])) {
			continue
		}
		online, _ := d["isOnline"].(bool)
		if _, exists := d["isOnline"]; !exists {
			online, _ = d["online"].(bool)
		}
		room := roomOf[did]
		if room == "" {
			room = "未分配房间"
		}
		devices = append(devices, deviceInfo{DID: did, Room: room, Online: online})
		if _, ok := roomMap[room]; !ok {
			roomMap[room] = &roomInfo{Name: room}
			roomOrder = append(roomOrder, room)
		}
		roomMap[room].Total++
		if online {
			roomMap[room].Online++
		}
	}

	rooms := make([]roomInfo, 0, len(roomOrder))
	for _, name := range roomOrder {
		rooms = append(rooms, *roomMap[name])
	}
	sort.SliceStable(rooms, func(i, j int) bool {
		if rooms[i].Name == "未分配房间" {
			return false
		}
		if rooms[j].Name == "未分配房间" {
			return true
		}
		return rooms[i].Name < rooms[j].Name
	})

	onlineCount := 0
	for _, d := range devices {
		if d.Online {
			onlineCount++
		}
	}
	data := &roomsData{
		OK:        true,
		Rooms:     rooms,
		Devices:   devices,
		Total:     totalInfo{Online: onlineCount, Total: len(devices)},
		UpdatedAt: time.Now().UnixMilli(),
	}

	s.roomsMu.Lock()
	s.roomsKey, s.roomsAt, s.roomsData, s.roomsFail = key, time.Now(), data, ""
	s.roomsMu.Unlock()
	return data, nil
}

// ---------------------------------------------------------------- 引擎重启

func (s *qrService) restartEngine() bool {
	s.infof("restarting go2rtc via api")
	req, err := http.NewRequest("POST", s.apiBase+"/api/restart", nil)
	if err == nil {
		if res, derr := (&http.Client{Timeout: 3 * time.Second}).Do(req); derr == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()
		}
	}
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	for i := 0; i < 60; i++ {
		res, derr := client.Get(s.apiBase + "/api")
		if derr == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()
			if res.StatusCode < 500 {
				s.infof("go2rtc is up")
				return true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	s.infof("go2rtc did not come up")
	return false
}

// ---------------------------------------------------------------- HTTP 接口

func (s *qrService) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	u, err := url.Parse(origin)
	if err != nil {
		return
	}
	host := r.Host
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	loop := map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true, "[::1]": true}
	if u.Hostname() == host || loop[u.Hostname()] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	}
}

func (s *qrService) sendJSON(w http.ResponseWriter, r *http.Request, status int, data any) {
	body, _ := json.Marshal(data)
	s.cors(w, r)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (s *qrService) register(mux *http.ServeMux) {
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		s.sendJSON(w, r, 200, map[string]any{"ok": true, "service": "qr-login"})
	})

	mux.HandleFunc("/qr/new", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			s.cors(w, r)
			w.WriteHeader(204)
			return
		}
		s.sessionMu.Lock()
		old := s.session
		if old != nil {
			old.cancel()
		}
		session := newQRSession()
		s.sessionMu.Unlock()

		if err := session.start(s); err != nil {
			s.infof("qr start failed: %v", err)
			s.sendJSON(w, r, 502, map[string]any{"ok": false, "error": "获取二维码失败，请检查网络后重试"})
			return
		}
		s.sessionMu.Lock()
		s.session = session
		s.sessionMu.Unlock()

		sess := session.snapshot()
		expiresIn, _ := sess["expiresIn"].(int)
		s.sendJSON(w, r, 200, map[string]any{
			"ok":        true,
			"sid":       session.sid,
			"qr":        "data:image/png;base64," + base64.StdEncoding.EncodeToString(session.image),
			"expiresIn": expiresIn,
		})
	})

	mux.HandleFunc("/qr/image", func(w http.ResponseWriter, r *http.Request) {
		sid := r.URL.Query().Get("sid")
		s.sessionMu.Lock()
		session := s.session
		s.sessionMu.Unlock()
		if session == nil || session.sid != sid || len(session.image) == 0 {
			s.sendJSON(w, r, 404, map[string]any{"ok": false, "error": "qr not found"})
			return
		}
		s.cors(w, r)
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(session.image)
	})

	mux.HandleFunc("/qr/status", func(w http.ResponseWriter, r *http.Request) {
		sid := r.URL.Query().Get("sid")
		s.sessionMu.Lock()
		session := s.session
		s.sessionMu.Unlock()
		if session == nil || session.sid != sid {
			s.sendJSON(w, r, 200, map[string]any{"state": "unknown", "message": "会话不存在或已刷新"})
			return
		}
		s.sendJSON(w, r, 200, session.snapshot())
	})

	mux.HandleFunc("/qr/cancel", func(w http.ResponseWriter, r *http.Request) {
		sid := r.URL.Query().Get("sid")
		s.sessionMu.Lock()
		session := s.session
		s.sessionMu.Unlock()
		if session != nil && session.sid == sid {
			session.cancel()
			s.infof("qr session canceled")
		}
		s.sendJSON(w, r, 200, map[string]any{"ok": true})
	})

	mux.HandleFunc("/rooms", func(w http.ResponseWriter, r *http.Request) {
		tokens := s.readXiaomiTokens()
		user := r.URL.Query().Get("id")
		if user == "" {
			for k := range tokens {
				user = k
				break
			}
		}
		region := r.URL.Query().Get("region")
		if region == "" {
			region = "cn"
		}
		if user == "" || tokens[user] == "" {
			s.sendJSON(w, r, 404, map[string]any{"ok": false, "error": "没有可用的登录令牌"})
			return
		}
		data, err := s.fetchRooms(user, region)
		if err != nil {
			s.infof("rooms failed for %s: %v", maskUID(user), err)
			s.sendJSON(w, r, 502, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		s.sendJSON(w, r, 200, data)
	})
}
