package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleConfig = `api:
  listen: "127.0.0.1:19840"
  static_dir: "web"

# 登录令牌：扫码或密码登录成功后写入
xiaomi:

streams:
`

func newTestService(t *testing.T) (*qrService, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "go2rtc.yaml")
	if err := os.WriteFile(path, []byte(sampleConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	return newQRService(path, "http://127.0.0.1:19840", ""), path
}

func TestSaveTokenWritesCredentials(t *testing.T) {
	s, path := newTestService(t)
	cred := credential{
		PassToken:    "pass-token-1",
		ServiceToken: "service-token-1",
		CUserID:      "cuser-1",
		SSecurity:    "c2VjcmV0",
	}
	if err := s.saveToken("1234567890", cred); err != nil {
		t.Fatal(err)
	}

	if got := s.readXiaomiTokens()["1234567890"]; got != "pass-token-1" {
		t.Fatalf("passToken = %q", got)
	}
	creds := s.readCredentials()
	got, ok := creds["1234567890"]
	if !ok {
		t.Fatal("credentials not written")
	}
	if got.ServiceToken != "service-token-1" || got.SSecurity != "c2VjcmV0" || got.CUserID != "cuser-1" {
		t.Fatalf("credentials = %+v", got)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, "static_dir") || !strings.Contains(text, "# 登录令牌") {
		t.Fatal("existing config lines were not preserved")
	}
	if strings.Index(text, "xiaomi-credentials:") > strings.Index(text, "streams:") {
		t.Fatal("xiaomi-credentials inserted after streams")
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatal("backup not written")
	}
}

func TestSaveTokenKeepsOtherUsers(t *testing.T) {
	s, path := newTestService(t)
	if err := s.saveToken("111", credential{PassToken: "a", ServiceToken: "s1", SSecurity: "c2VjcmV0", CUserID: "c1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.saveToken("222", credential{PassToken: "b", ServiceToken: "s2", SSecurity: "c2VjcmV0", CUserID: "c2"}); err != nil {
		t.Fatal(err)
	}
	tokens := s.readXiaomiTokens()
	if tokens["111"] != "a" || tokens["222"] != "b" {
		t.Fatalf("tokens = %v", tokens)
	}
	creds := s.readCredentials()
	if len(creds) != 2 || creds["111"].ServiceToken != "s1" || creds["222"].ServiceToken != "s2" {
		t.Fatalf("credentials = %+v", creds)
	}
	raw, _ := os.ReadFile(path)
	if strings.Count(string(raw), "xiaomi-credentials:") != 1 {
		t.Fatal("duplicated xiaomi-credentials block")
	}
}

func TestSaveTokenWithoutCredentialsRemovesNested(t *testing.T) {
	s, path := newTestService(t)
	if err := s.saveToken("111", credential{PassToken: "a", ServiceToken: "s1", SSecurity: "c2VjcmV0", CUserID: "c1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.saveToken("111", credential{PassToken: "a2"}); err != nil {
		t.Fatal(err)
	}
	if creds := s.readCredentials(); len(creds) != 0 {
		t.Fatalf("stale credentials left: %+v", creds)
	}
	if got := s.readXiaomiTokens()["111"]; got != "a2" {
		t.Fatalf("passToken = %q", got)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "xiaomi:") {
		t.Fatal("xiaomi block removed unexpectedly")
	}
}

func TestPersistRefreshedToken(t *testing.T) {
	s, _ := newTestService(t)
	if err := s.saveToken("111", credential{PassToken: "old", ServiceToken: "s1", SSecurity: "c2VjcmV0", CUserID: "c1"}); err != nil {
		t.Fatal(err)
	}
	session := newHTTPSession()
	session.cookies["passToken"] = "new"
	auth := &cloudAuth{session: session}

	s.persistRefreshedToken("111", "old", auth, "old")
	if got := s.readXiaomiTokens()["111"]; got != "new" {
		t.Fatalf("rotated token not persisted: %q", got)
	}

	// 配置已被别的进程更新过时不能覆盖
	s.persistRefreshedToken("111", "old", auth, "old")
	if got := s.readXiaomiTokens()["111"]; got != "new" {
		t.Fatalf("token = %q", got)
	}
}

func TestCRLFCrlfPreserved(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "go2rtc.yaml")
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(sampleConfig, "\n", "\r\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newQRService(path, "http://127.0.0.1:19840", "")
	if err := s.saveToken("111", credential{PassToken: "a"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "\n") && !strings.Contains(string(raw), "\r\n") {
		t.Fatal("CRLF line endings were not preserved")
	}
}
