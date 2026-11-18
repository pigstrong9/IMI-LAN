package main

// 云台（PTZ）控制。
//
// 有两条通道，优先级不同：
//
// 1. miss 命令通道（主路径）—— 转动命令是视频连接里的 MISS 0x112，
//    带 {"operation":1..4}（1=左 2=右 3=上 4=下），{"operation":-1001} 停止。
//    官方 go2rtc 只定义了这个常量、没有开放调用，本项目用
//    fpk/patches/xiaomi-control.patch 补上 POST /api/xiaomi/command。
//    实测 C700（chuangmi.camera.81ac1）、xiaovv、叮零、母婴看护版这些型号
//    的公开 MIoT 规格里都**没有**云台动作，真实通道就是这一条。
//
// 2. MIoT 云端 miotspec/action（兜底）—— 少数型号的公开规格里确实有云台动作，
//    这时网关用扫码拿到的 serviceToken + ssecurity 直接签名调用。
//    各型号的 siid/aiid/piid 与取值命名不统一（"left" / "pan_left" / 数字枚举），
//    所以先去 miot-spec.org 按型号拉公开规格解析；解析不到再回退 2/1/1。
//
// 命令通道必须「画面正在播」才可用：摄像头只在视频连接里接受这类命令。
//
// 桌面版（Electron）不启动网关，由 fpk/patches/xiaomi-control.patch 在 go2rtc
// 里提供响应结构相同的 /ptz、/ptz/spec；那份实现没有云端接口，只按
// 固定机 / 门铃名单隐藏方向盘，其余型号默认开放命令通道。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	miotSpecListURL = "https://miot-spec.org/miot-spec-v2/instances?status=all"
	miotSpecTypeURL = "https://miot-spec.org/miot-spec-v2/instance?type="
)

// 前端只发语义方向，具体下发值由规格里的 value-list 匹配出来。
var ptzDirAliases = map[string][]string{
	"left":       {"left", "pan_left", "turn_left", "leftward", "左", "左转"},
	"right":      {"right", "pan_right", "turn_right", "rightward", "右", "右转"},
	"up":         {"up", "tilt_up", "turn_up", "upward", "上", "上转"},
	"down":       {"down", "tilt_down", "turn_down", "downward", "下", "下转"},
	"left_up":    {"left_up", "left-up", "up_left", "up-left", "左上"},
	"right_up":   {"right_up", "right-up", "up_right", "up-right", "右上"},
	"left_down":  {"left_down", "left-down", "down_left", "down-left", "左下"},
	"right_down": {"right_down", "right-down", "down_right", "down-right", "右下"},
}

// 方向展示顺序：前四个是必需项，斜向只在规格里确实有对应取值时才暴露。
var ptzDirOrder = []string{"left", "right", "up", "down", "left_up", "right_up", "left_down", "right_down"}

// 已知没有云台的机型：固定机 + 门铃。策略是 fail-open —— 除了这些明确
// 没有云台的型号，其余（包括公开规格查不到 / 离线 / 未登录的新型号）都
// 开放视频连接里的命令通道。新设备不用等代码更新，画面不动就说明不是云台机。
var knownFixedModels = map[string]bool{
	"mijia.camera.v3": true, // 米家智能摄像机 1080P（固定机）
}

// 门铃统一是 madv.cateye.*，电池设备，没有云台。
func ptzKnownFixed(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return false
	}
	return knownFixedModels[m] || strings.HasPrefix(m, "madv.cateye.")
}

type ptzSpec struct {
	Model   string         `json:"model"`
	Siid    int            `json:"siid"`
	Aiid    int            `json:"aiid"`
	Piid    int            `json:"piid"`
	Format  string         `json:"format"`
	Action  string         `json:"action"`
	Source  string         `json:"source"`
	Note    string         `json:"note,omitempty"`
	Dirs    []string       `json:"dirs"`
	DirVals map[string]any `json:"-"`
	// Supported 在 resolvePtzSpec 里表示「公开规格里有可直接调用的云台动作」；
	// specWithChannel 发现命令通道可用时也会把它补成 true（含未收录的新型号）。
	// 前端据此决定要不要显示方向盘。
	Supported bool `json:"supported"`
	// PTZCapable 表示该型号本身是云台机（规格里有 ptz 相关属性），
	// 但公开规格里没有可直接调用的云台动作。
	PTZCapable bool `json:"ptzCapable"`
	// Channel 是实际可用的控制通道：miss（视频连接里的命令通道）或 cloud（MIoT 云端）。
	Channel string `json:"channel,omitempty"`
}

type miotParam struct {
	// 属性用 IID 编号，动作入参用 Piid；in 里写数字时指的是同服务下属性的 IID。
	IID       int    `json:"iid"`
	Piid      int    `json:"piid"`
	Type      string `json:"type"`
	Desc      string `json:"description"`
	Format    string `json:"format"`
	ValueList []any  `json:"value-list"`
}

// 规格里 in 有两种写法：[{"piid":1,"value-list":[...]}] 和 [1]。
// 后者只给编号，取值要从同服务的同名属性上找。按对象硬解会让整个规格解析失败
// （这正是之前「云台怎么都不动」的真正原因：解析失败 → 全部退化成 fallback）。
func (m *miotParam) UnmarshalJSON(b []byte) error {
	var n int
	if err := json.Unmarshal(b, &n); err == nil {
		*m = miotParam{Piid: n}
		return nil
	}
	type raw miotParam
	var r raw
	if err := json.Unmarshal(b, &r); err != nil {
		return err
	}
	*m = miotParam(r)
	return nil
}

// propValues 按 piid 去同服务里找属性的取值表（in 只给编号时用）。
func propValues(svc miotService, piid int) ([]any, string) {
	for _, p := range svc.Properties {
		if p.IID == piid {
			return p.ValueList, p.Format
		}
	}
	return nil, ""
}

type miotAction struct {
	IID  int         `json:"iid"`
	Type string      `json:"type"`
	Desc string      `json:"description"`
	In   []miotParam `json:"in"`
}

type miotService struct {
	IID        int          `json:"iid"`
	Type       string       `json:"type"`
	Desc       string       `json:"description"`
	Actions    []miotAction `json:"actions"`
	Properties []miotParam  `json:"properties"`
}

type miotInstanceDetail struct {
	Services []miotService `json:"services"`
}

// 规格解析结果按型号缓存；同一个网关进程只拉一次公开规格表。
var (
	ptzMu        sync.Mutex
	ptzFetchMu   sync.Mutex // 串行化外网解析，避免并发冷请求重复下载同一份规格
	ptzSpecCache = map[string]*ptzSpec{}
	ptzSpecAt    = map[string]time.Time{}
	miotIndex    map[string]string
	miotIndexAt  time.Time
)

const ptzSpecTTL = 24 * time.Hour

func httpBytes(rawurl string) ([]byte, error) {
	req, err := http.NewRequest("GET", rawurl, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "imi-lan-gateway/1.0 (+ptz)")
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 16<<20))
}

func httpJSON(rawurl string, out any) error {
	body, err := httpBytes(rawurl)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// parseModelIndex 解析型号 -> 规格 urn 的映射。
// 接口返回的是 {"instances":[...]}，不是裸数组；之前按数组解析会静默失败，
// 于是所有型号都掉进 fallback，云台方向永远对不上。
func parseModelIndex(body []byte) (map[string]string, error) {
	var payload struct {
		Instances []struct {
			Type  string `json:"type"`
			Model string `json:"model"`
		} `json:"instances"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if len(payload.Instances) == 0 {
		return nil, errors.New("规格列表为空：接口结构可能又变了")
	}
	idx := make(map[string]string, len(payload.Instances))
	for _, it := range payload.Instances {
		if it.Model != "" && it.Type != "" {
			idx[strings.ToLower(it.Model)] = it.Type
		}
	}
	return idx, nil
}

// modelIndex 拉一次全量型号表，cache 一天。表大约 1.5MB，只在本机内存里留映射。
func modelIndex() (map[string]string, error) {
	ptzMu.Lock()
	if miotIndex != nil && time.Since(miotIndexAt) < 24*time.Hour {
		idx := miotIndex
		ptzMu.Unlock()
		return idx, nil
	}
	ptzMu.Unlock()

	body, err := httpBytes(miotSpecListURL)
	if err != nil {
		return nil, err
	}
	idx, err := parseModelIndex(body)
	if err != nil {
		return nil, err
	}
	ptzMu.Lock()
	miotIndex, miotIndexAt = idx, time.Now()
	ptzMu.Unlock()
	return idx, nil
}

func ptzLooksLikeAction(a miotAction) bool {
	t := strings.ToLower(a.Type)
	d := a.Desc
	if strings.Contains(t, "ptz") || strings.Contains(t, "motor") {
		return true
	}
	if strings.Contains(t, "move") && !strings.Contains(t, "move-") {
		return true
	}
	for _, kw := range []string{"云台", "转动", "转向", "方向"} {
		if strings.Contains(d, kw) {
			return true
		}
	}
	return false
}

// 从规格里挑最像云台的那个动作：优先 type 同时含 ptz 和 move。
func pickPtzAction(svc miotService) (miotAction, int) {
	best := miotAction{}
	score := -1
	for _, a := range svc.Actions {
		if len(a.In) == 0 || !ptzLooksLikeAction(a) {
			continue
		}
		t := strings.ToLower(a.Type)
		c := 1
		if strings.Contains(t, "ptz") {
			c += 4
		}
		if strings.Contains(t, "move") {
			c += 2
		}
		if c > score {
			best, score = a, c
		}
	}
	return best, score
}

func matchValue(values []any, dir string) (any, bool) {
	// 规格里的说法不统一："tilt_up" / "Tilt Up" / "tilt-up" 都表示上。
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		s = strings.ReplaceAll(s, " ", "_")
		return strings.ReplaceAll(s, "-", "_")
	}
	alts := ptzDirAliases[dir]
	for _, alt := range alts {
		alt = norm(alt)
		for _, v := range values {
			switch x := v.(type) {
			case string:
				if norm(x) == alt {
					return x, true
				}
			case map[string]any:
				// 数字枚举常写成 {"value":1,"description":"left"}，
				// 只认纯字符串会把这类规格整段漏掉。
				for _, key := range []string{"description", "desc", "name"} {
					s, _ := x[key].(string)
					if norm(s) == alt {
						return x["value"], true
					}
				}
			}
		}
	}
	return nil, false
}

// resolvePtzSpec 解析某型号的云台动作；失败时返回内置回退（并带上 note 说明）。
func resolvePtzSpec(model string) *ptzSpec {
	key := strings.ToLower(model)
	ptzMu.Lock()
	sp, ok := ptzSpecCache[key]
	if ok && time.Since(ptzSpecAt[key]) < ptzSpecTTL {
		ptzMu.Unlock()
		return sp
	}
	ptzMu.Unlock()

	// 解析过程会联网，串行化避免同一型号被并发请求下载多次。
	ptzFetchMu.Lock()
	defer ptzFetchMu.Unlock()
	ptzMu.Lock()
	sp, ok = ptzSpecCache[key]
	if ok && time.Since(ptzSpecAt[key]) < ptzSpecTTL {
		ptzMu.Unlock()
		return sp
	}
	ptzMu.Unlock()

	spec := &ptzSpec{
		Model: model, Siid: 2, Aiid: 1, Piid: 1, Format: "string",
		Source: "fallback", Action: "builtin ptz-move",
		Note: "未能从 miot-spec.org 解析该型号，按最常见的 siid2/aiid1 尝试",
	}
	fallbackDirs := []string{"left", "right", "up", "down"}
	spec.Dirs, spec.DirVals = fallbackDirs, nil
	for _, d := range fallbackDirs {
		if v, ok := matchValue([]any{"left", "right", "up", "down", "left_up", "right_up", "left_down", "right_down"}, d); ok {
			if spec.DirVals == nil {
				spec.DirVals = map[string]any{}
			}
			spec.DirVals[d] = v
		}
	}

	if model != "" {
		if idx, err := modelIndex(); err == nil {
			if urn, ok := idx[key]; ok {
				var detail miotInstanceDetail
				if err := httpJSON(miotSpecTypeURL+url.QueryEscape(urn), &detail); err == nil {
					// 先看这台是不是云台机：规格里有 ptz-camera / ptz 系列属性
					for _, svc := range detail.Services {
						for _, p := range svc.Properties {
							t := strings.ToLower(p.Type + " " + p.Desc)
							for _, kw := range []string{"ptz", "pan", "tilt", "motor", "云台", "转动", "转向"} {
								if strings.Contains(t, kw) {
									spec.PTZCapable = true
								}
							}
						}
					}
					foundAction := false
					for _, svc := range detail.Services {
						act, score := pickPtzAction(svc)
						if score < 0 {
							continue
						}
						foundAction = true
						p := act.In[0]
						// in 只给编号时，取值表挂在同服务的属性上
						choices := p.ValueList
						format := p.Format
						if len(choices) == 0 && p.Piid > 0 {
							if pv, pf := propValues(svc, p.Piid); len(pv) > 0 {
								choices, format = pv, pf
							}
						}
						dirs := []string{}
						vals := map[string]any{}
						for _, d := range ptzDirOrder {
							if v, ok := matchValue(choices, d); ok {
								dirs = append(dirs, d)
								vals[d] = v
							}
						}
						if len(dirs) == 0 {
							spec.Note = "已找到云台动作，但入参取值无法识别（可能是数字枚举）"
							continue
						}
						spec.Siid, spec.Aiid, spec.Piid = svc.IID, act.IID, p.Piid
						spec.Format = format
						spec.Action = act.Desc
						spec.Source = "spec"
						spec.Note = ""
						spec.Dirs, spec.DirVals = dirs, vals
						spec.Supported = true
						break
					}
					if !foundAction {
						// 这批摄像机（C700 / xiaovv / 叮零）就是这种情况：
						// 云台机，但转动命令走 P2P 视频连接里的 cmd 通道。
						spec.Note = "该型号的公开规格里没有云台动作，转动命令走 P2P 通道"
					}
				}
			}
		}
	}

	// 没解析出可用动作时不要保留 fallback 的方向表：
	// 否则接口会同时说「不支持」又给出一堆方向，前端和调试都容易误判。
	if !spec.Supported {
		spec.Dirs, spec.DirVals = nil, nil
		spec.Source = "unsupported"
		spec.Action = ""
	}

	ptzMu.Lock()
	ptzSpecCache[key] = spec
	ptzSpecAt[key] = time.Now()
	ptzMu.Unlock()
	return spec
}

// deviceModelOf 从 /rooms 缓存里查 did 对应的型号；缓存过期会自动重拉。
func (s *qrService) deviceModelOf(user, region, did string) (string, error) {
	data, err := s.fetchRooms(user, region)
	if err != nil {
		return "", err
	}
	for _, d := range data.Devices {
		if d.DID == did {
			return d.Model, nil
		}
	}
	return "", errors.New("房间里没有这个设备，可能已离线或不在当前账号")
}

func (s *qrService) ptzAuth(user, region string) (*cloudAuth, error) {
	if user == "" {
		return nil, errors.New("缺少账号")
	}
	if auth := s.authFromCredentials(user); auth != nil {
		return auth, nil
	}
	auth, _, err := s.getAuth(user, s.readXiaomiTokens()[user], false)
	if err != nil {
		return nil, err
	}
	if auth == nil {
		return nil, errors.New("小米账号登录失败，请重新扫码")
	}
	return auth, nil
}

// ---------------------------------------------------------------- HTTP 路由

// ptzMissOps 是 MISS 0x112 电机命令的 operation 取值：1=左 2=右 3=上 4=下。
// 云台只有这四个方向，没有斜向 —— 斜向要靠两条命令接力，那就不是「一步」了。
var ptzMissOps = map[string]int{
	"left":  1,
	"right": 2,
	"up":    3,
	"down":  4,
}

const (
	ptzMissCmd = 0x112
	// 停止。operation 1..4 在多数固件上是「持续朝该方向转」，不补一条停止会一直转到限位。
	ptzStopOp = -1001
)

var ptzMissDirs = []string{"left", "right", "up", "down"}

// missCommand 让 go2rtc 把一条 MISS 命令发到正在播放的摄像机上。
func (s *qrService) missCommand(src string, cmd uint32, data string) (string, error) {
	q := url.Values{}
	q.Set("src", src)
	q.Set("cmd", fmt.Sprintf("0x%x", cmd))
	q.Set("data", data)

	req, err := http.NewRequest(http.MethodPost,
		s.apiBase+"/api/xiaomi/command?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}

	res, err := s.apiClient(6 * time.Second).Do(req)
	if err != nil {
		// url.Error 会把整条 http://127.0.0.1:xxxxx/api/...?data=%7B... 拽进来，
		// 这句话是要上手机屏幕的。只留根因。
		var uerr *url.Error
		if errors.As(err, &uerr) && uerr.Err != nil {
			return "", fmt.Errorf("播放引擎没有响应（%v）", uerr.Err)
		}
		return "", fmt.Errorf("播放引擎没有响应（%v）", err)
	}
	defer res.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if readErr != nil {
		return "", fmt.Errorf("读取播放引擎响应失败：%v", readErr)
	}

	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusConflict:
		return "", errors.New("画面还没连上摄像机，等画面出来再控制云台")
	case http.StatusNotFound:
		return "", fmt.Errorf("播放引擎里没有「%s」这个画面", src)
	case http.StatusMethodNotAllowed:
		return "", errors.New("播放引擎没有云台命令接口，需要装带 xiaomi-control 补丁的版本")
	default:
		msg := strings.TrimSpace(string(body))
		if msg == "" {
			msg = fmt.Sprintf("播放引擎返回 HTTP %d", res.StatusCode)
		}
		return "", errors.New(msg)
	}

	var out struct {
		OK    bool   `json:"ok"`
		Reply string `json:"reply"`
		Hex   string `json:"hex"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("播放引擎返回了看不懂的结果：%v", err)
	}
	return out.Reply, nil
}

// specWithChannel 返回补上通道信息的规格副本。
// resolvePtzSpec 的结果是带缓存的指针，直接改会把缓存写脏（第二次进来
// 就会拿到已经「支持」的旧结论）。
func specWithChannel(model string, spec *ptzSpec) *ptzSpec {
	var out ptzSpec
	if spec != nil {
		out = *spec
	}
	out.Model = model

	if out.Supported {
		out.Channel = "cloud"
		return &out
	}

	// 规格里没有云台动作 —— 这正是这批摄像机的常态，改走视频连接里的命令通道。
	// 只有「明确知道没有云台」的固定机 / 门铃才隐藏；未收录的新型号默认开放，
	// 用户不用等代码更新，画面不动就说明不是云台机。
	if ptzKnownFixed(model) {
		out.Supported = false
		out.Channel = ""
		out.Dirs = nil
		out.DirVals = nil
		out.Note = "该型号是固定机/门铃，没有云台，不显示方向盘"
		return &out
	}
	out.Channel = "miss"
	out.Supported = true
	out.Source = "miss"
	out.Action = "MISS 0x112 motor"
	out.Dirs = ptzMissDirs
	out.DirVals = nil
	if model == "" {
		out.Note = "流地址里没有型号信息，仍显示方向盘；画面不动说明这台不是云台机或已到角度极限"
	} else {
		out.Note = "型号未单独适配，默认显示方向盘；画面不动说明这台不是云台机或已到角度极限"
	}
	return &out
}

// firstAccount 稳定地选一个已登录账号（map 遍历顺序是随机的，多账号时
// 每次请求挑到不同账号会让问题难以复现）。
func (s *qrService) firstAccount() string {
	tokens := s.readXiaomiTokens()
	keys := make([]string, 0, len(tokens))
	for k := range tokens {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return ""
	}
	return keys[0]
}

func (s *qrService) registerPTZ(mux *http.ServeMux) {
	// 查询某个画面能不能控云台、能控哪些方向（前端据此决定要不要显示方向盘）。
	mux.HandleFunc("/ptz/spec", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			s.cors(w, r)
			w.WriteHeader(204)
			return
		}
		did := r.URL.Query().Get("did")
		region := r.URL.Query().Get("region")
		if region == "" {
			region = "cn"
		}
		user := r.URL.Query().Get("id")
		if user == "" {
			user = s.firstAccount()
		}

		// 型号只用来把说明写准一点，查不到也不影响走命令通道
		var model string
		var spec *ptzSpec
		if did != "" {
			if m, err := s.deviceModelOf(user, region, did); err == nil {
				model = m
				spec = resolvePtzSpec(model)
			}
		}

		out := specWithChannel(model, spec)
		s.sendJSON(w, r, 200, map[string]any{
			"ok": true, "did": did, "model": model, "spec": out,
		})
	})

	mux.HandleFunc("/ptz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			s.cors(w, r)
			w.WriteHeader(204)
			return
		}
		q := r.URL.Query()
		name := strings.TrimSpace(q.Get("name"))
		did := q.Get("did")
		move := strings.ToLower(strings.TrimSpace(q.Get("move")))
		region := q.Get("region")
		if region == "" {
			region = "cn"
		}
		user := q.Get("id")
		if user == "" {
			user = s.firstAccount()
		}
		if move == "" {
			s.sendJSON(w, r, 400, map[string]any{"ok": false, "error": "缺少 move"})
			return
		}

		var model string
		var spec *ptzSpec
		if did != "" {
			if m, err := s.deviceModelOf(user, region, did); err == nil {
				model = m
				spec = resolvePtzSpec(model)
			}
		}

		// 1) 命令通道优先：这是这批摄像机的真实路径，只要画面在播就能发。
		var payload string
		if move == "stop" {
			payload = fmt.Sprintf(`{"operation":%d}`, ptzStopOp)
		} else if op, ok := ptzMissOps[move]; ok {
			payload = fmt.Sprintf(`{"operation":%d}`, op)
		}

		var missErr error
		if name == "" {
			missErr = errors.New("缺少 name（画面名），命令发不到摄像机")
		} else if payload == "" {
			missErr = fmt.Errorf("云台只有上下左右四个方向，没有「%s」", move)
		} else if reply, err := s.missCommand(name, ptzMissCmd, payload); err == nil {
			s.infof("ptz %s via miss (name=%s model=%s) reply=%s", move, name, model, reply)
			s.sendJSON(w, r, 200, map[string]any{
				"ok": true, "channel": "miss", "name": name, "move": move,
				"model": model, "data": payload, "reply": reply,
			})
			return
		} else {
			missErr = err
		}

		// 2) 兜底：少数型号的公开规格里确实有云台动作，走云端 MIoT。
		cloudSpec := specWithChannel(model, spec)
		if cloudSpec.Channel != "cloud" || len(cloudSpec.DirVals) == 0 {
			s.sendJSON(w, r, 501, map[string]any{
				"ok": false, "error": missErr.Error(), "model": model,
				"channel": "miss", "dirs": ptzMissDirs, "note": specNote(spec),
			})
			return
		}

		siid, aiid, piid := cloudSpec.Siid, cloudSpec.Aiid, cloudSpec.Piid
		// 显式带参数时放行，方便换型号手动试；写坏了就保持规格里的值，
		// 不能让 siid=abc 静默把参数清零。
		parseOverride := func(key string, dst *int) {
			if v := q.Get(key); v != "" {
				var n int
				if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
					*dst = n
				}
			}
		}
		parseOverride("siid", &siid)
		parseOverride("aiid", &aiid)
		parseOverride("piid", &piid)

		var value any
		if raw := q.Get("value"); raw != "" {
			value = raw
		} else if v, ok := cloudSpec.DirVals[move]; ok {
			value = v
		} else {
			s.sendJSON(w, r, 400, map[string]any{
				"ok": false, "error": "该型号没有方向：" + move,
				"dirs": cloudSpec.Dirs, "source": cloudSpec.Source, "note": cloudSpec.Note,
			})
			return
		}

		auth, err := s.ptzAuth(user, region)
		if err != nil {
			s.sendJSON(w, r, 502, map[string]any{"ok": false, "error": err.Error()})
			return
		}

		body := map[string]any{"params": []any{map[string]any{
			"did": did, "siid": siid, "aiid": aiid,
			"in": []any{map[string]any{"piid": piid, "value": value}},
		}}}
		res, err := cloudRequest(auth, region, "/miotspec/action", body)
		if err != nil {
			s.infof("ptz %s failed (channel=cloud model=%s siid=%d aiid=%d piid=%d value=%v): %v",
				move, model, siid, aiid, piid, value, err)
			s.sendJSON(w, r, 502, map[string]any{
				"ok": false, "error": err.Error(), "channel": "cloud",
				"model": model, "siid": siid, "aiid": aiid, "piid": piid, "value": value,
				"missError": missErr.Error(),
			})
			return
		}
		s.sendJSON(w, r, 200, map[string]any{
			"ok": true, "channel": "cloud", "model": model, "move": move, "value": value,
			"siid": siid, "aiid": aiid, "piid": piid, "result": res,
		})
	})
}

func specNote(spec *ptzSpec) string {
	if spec == nil {
		return ""
	}
	return spec.Note
}
