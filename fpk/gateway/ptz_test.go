package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// 锁死这次的坑：miot-spec 的型号列表接口返回的是 {"instances":[...]}，
// 按裸数组解析会静默失败，导致所有型号都掉进 fallback、云台方向永远对不上。
func TestParseModelIndexWrapper(t *testing.T) {
	body := []byte(`{"instances":[
		{"status":"released","model":"Chuangmi.Camera.81AC1","type":"urn:miot-spec-v2:device:camera:0000A01C:chuangmi-81ac1:5"},
		{"status":"released","model":"xiaovv.camera.q8","type":"urn:miot-spec-v2:device:camera:0000A01C:xiaovv-q8:2"}
	]}`)

	idx, err := parseModelIndex(body)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(idx) != 2 {
		t.Fatalf("期望 2 条，实际 %d", len(idx))
	}
	// 型号统一转小写，云端返回的大小写不固定
	if got := idx["chuangmi.camera.81ac1"]; got != "urn:miot-spec-v2:device:camera:0000A01C:chuangmi-81ac1:5" {
		t.Fatalf("大小写归一化失败: %q", got)
	}
}

func TestParseModelIndexBareArrayFails(t *testing.T) {
	// 裸数组是以前错误的假设，必须报错而不是返回空表装成功
	if _, err := parseModelIndex([]byte(`[{"model":"a","type":"b"}]`)); err == nil {
		t.Fatal("裸数组应当返回错误，避免又静默退化成 fallback")
	}
}

// 摄像机型号的公开规格里没有云台动作：解析结果必须是「不支持」，
// 前端据此隐藏方向盘，而不是盲调云端让用户看到一堆报错。
func TestResolvePtzSpecNoCloudAction(t *testing.T) {
	if testing.Short() {
		t.Skip("需要访问 miot-spec.org")
	}
	if _, err := modelIndex(); err != nil {
		t.Skipf("外网不可用，跳过: %v", err)
	}

	for _, model := range []string{"chuangmi.camera.81ac1", "xiaovv.camera.q8"} {
		spec := resolvePtzSpec(model)
		if spec.Supported {
			t.Errorf("%s: 公开规格里没有云台动作，Supported 应为 false（来源=%s dirs=%v）",
				model, spec.Source, spec.Dirs)
		}
		if spec.PTZCapable && len(spec.Dirs) > 0 {
			t.Errorf("%s: 不支持却给出了方向列表", model)
		}
	}
}

func TestResolvePtzSpecC700IsPtzCamera(t *testing.T) {
	if testing.Short() {
		t.Skip("需要访问 miot-spec.org")
	}
	if _, err := modelIndex(); err != nil {
		t.Skipf("外网不可用，跳过: %v", err)
	}
	// C700 规格里有 ptz-camera 属性，属于云台机，但没有可下发的动作
	if spec := resolvePtzSpec("chuangmi.camera.81ac1"); !spec.PTZCapable {
		t.Fatalf("C700 应被识别为云台机，实际 ptzCapable=false（来源=%s note=%s）",
			spec.Source, spec.Note)
	}
}

// 规格里没有云台动作的型号（这批摄像机的常态）必须走视频连接里的命令通道，
// 同时不能把 resolvePtzSpec 的缓存写脏 —— 它是带缓存的指针，
// 第一次请求把 Supported 改成 true 之后，第二次就会当成「规格里本来就有」。
func TestSpecWithChannelMissDoesNotPolluteCache(t *testing.T) {
	cached := &ptzSpec{
		Model: "chuangmi.camera.81ac1", Source: "unsupported", PTZCapable: true,
	}

	out := specWithChannel(cached.Model, cached)
	if out.Channel != "miss" {
		t.Fatalf("通道应为 miss，实际 %q", out.Channel)
	}
	if !out.Supported {
		t.Fatal("命令通道可用时 Supported 应为 true，否则前端不显示方向盘")
	}
	if len(out.Dirs) != 4 {
		t.Fatalf("云台只有四个方向，实际 %v", out.Dirs)
	}
	for _, d := range []string{"left", "right", "up", "down"} {
		found := false
		for _, x := range out.Dirs {
			if x == d {
				found = true
			}
		}
		if !found {
			t.Fatalf("缺少方向 %s", d)
		}
	}
	if out.DirVals != nil {
		t.Fatal("命令通道没有云端取值表，DirVals 必须为空")
	}

	if cached.Supported || cached.Source != "unsupported" || len(cached.Dirs) != 0 || cached.Channel != "" {
		t.Fatalf("缓存对象被改脏了：%+v", *cached)
	}

	again := specWithChannel(cached.Model, cached)
	if again.Channel != "miss" || !again.Supported {
		t.Fatalf("第二次调用结论应一致，实际 channel=%q supported=%v", again.Channel, again.Supported)
	}
}

// 公开规格里真有云台动作的型号不能被抢到命令通道：云端那条才是它的正确路径。
func TestSpecWithChannelKeepsCloud(t *testing.T) {
	cached := &ptzSpec{
		Model: "demo.camera.x", Supported: true, Source: "spec",
		Dirs: []string{"left"}, DirVals: map[string]any{"left": "left"},
		Siid: 2, Aiid: 1, Piid: 1,
	}

	out := specWithChannel(cached.Model, cached)
	if out.Channel != "cloud" {
		t.Fatalf("应保留云端通道，实际 %q", out.Channel)
	}
	if len(out.Dirs) != 1 || out.Dirs[0] != "left" {
		t.Fatalf("方向被覆盖了：%v", out.Dirs)
	}
	if out.DirVals["left"] != "left" {
		t.Fatal("云端取值表丢了")
	}
}

// operation 取值是摄像头的协议常量，不能随手改：1=左 2=右 3=上 4=下。
func TestPtzMissOpsPinned(t *testing.T) {
	want := map[string]int{"left": 1, "right": 2, "up": 3, "down": 4}
	if len(ptzMissOps) != len(want) {
		t.Fatalf("方向数不对：%v", ptzMissOps)
	}
	for dir, op := range want {
		if ptzMissOps[dir] != op {
			t.Fatalf("%s 应为 %d，实际 %d", dir, op, ptzMissOps[dir])
		}
	}
	if ptzStopOp != -1001 {
		t.Fatalf("停止命令应为 -1001，实际 %d", ptzStopOp)
	}
	if ptzMissCmd != 0x112 {
		t.Fatalf("电机命令应为 0x112，实际 %#x", ptzMissCmd)
	}
}

// 规格里 in 的两种写法都要认。以前按对象硬解，遇到 [1] 会让整份规格解析失败，
// 所有型号都掉进 fallback —— 这正是「云台怎么都不动」的根因。
func TestMiotParamUnmarshalJSON(t *testing.T) {
	var byNum miotParam
	if err := json.Unmarshal([]byte(`1`), &byNum); err != nil {
		t.Fatalf("数字写法解析失败: %v", err)
	}
	if byNum.Piid != 1 {
		t.Fatalf("数字写法应得到 piid=1，实际 %d", byNum.Piid)
	}

	var byObj miotParam
	if err := json.Unmarshal([]byte(`{"piid":2,"format":"string"}`), &byObj); err != nil {
		t.Fatalf("对象写法解析失败: %v", err)
	}
	if byObj.Piid != 2 || byObj.Format != "string" {
		t.Fatalf("对象写法字段丢失: %+v", byObj)
	}
}

func TestMatchValue(t *testing.T) {
	choices := []any{"left", "pan_right", map[string]any{"value": 3, "description": "Tilt Up"}}
	if v, ok := matchValue(choices, "left"); !ok || v != "left" {
		t.Fatalf("纯字符串没匹配上: v=%v ok=%v", v, ok)
	}
	if v, ok := matchValue(choices, "right"); !ok || v != "pan_right" {
		t.Fatalf("别名没匹配上: v=%v ok=%v", v, ok)
	}
	if v, ok := matchValue(choices, "up"); !ok || v != 3 {
		t.Fatalf("对象形式枚举没匹配上: v=%v ok=%v", v, ok)
	}
	if _, ok := matchValue(choices, "down"); ok {
		t.Fatal("不该匹配到 down")
	}
}

func TestPtzLooksLikeActionChinese(t *testing.T) {
	if !ptzLooksLikeAction(miotAction{Type: "camera_ptz_move", Desc: "云台转动"}) {
		t.Fatal("ptz / 中文云台描述都应识别为云台动作")
	}
	if ptzLooksLikeAction(miotAction{Type: "camera_snapshot", Desc: "拍照"}) {
		t.Fatal("拍照动作不应识别为云台动作")
	}
}

// 不支持云台的型号必须 fail closed —— 否则门铃、固定摄像机也会显示方向盘。
func TestSpecWithChannelRejectsFixedCamera(t *testing.T) {
	fixed := &ptzSpec{Model: "mijia.camera.v3", Source: "unsupported"}
	out := specWithChannel("mijia.camera.v3", fixed)
	if out.Supported || out.Channel != "" || len(out.Dirs) != 0 {
		t.Fatalf("固定摄像机不应显示方向盘: %+v", *out)
	}

	// 已知云台机型即使规格没解析出来，也要开放命令通道。
	ptz := specWithChannel("chuangmi.camera.81ac1", &ptzSpec{Source: "unsupported"})
	if !ptz.Supported || ptz.Channel != "miss" || len(ptz.Dirs) != 4 {
		t.Fatalf("已知云台机型应开放命令通道: %+v", *ptz)
	}
}

// 否定结论也会过期：规格站修正数据后，不能一直沿用上次的「不支持」。
func TestSpecCacheExpires(t *testing.T) {
	key := strings.ToLower("cache.expiry.camera")
	ptzMu.Lock()
	ptzSpecCache[key] = &ptzSpec{Model: key, Source: "unsupported"}
	ptzSpecAt[key] = time.Now().Add(-2 * ptzSpecTTL)
	ptzMu.Unlock()
	// 只验证缓存时间戳确实参与了判定，不触发外网请求。
	ptzMu.Lock()
	expired := time.Since(ptzSpecAt[key]) >= ptzSpecTTL
	delete(ptzSpecCache, key)
	delete(ptzSpecAt, key)
	ptzMu.Unlock()
	if !expired {
		t.Fatal("过期的缓存应被判定为失效")
	}
}
