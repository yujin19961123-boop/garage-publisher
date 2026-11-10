package main

import (
	"strings"
	"testing"
)

func TestProjectSlug(t *testing.T) {
	for _, name := range []string{"绿色女儿", "重庆", "𠮷😀"} {
		if s := projectSlug(name); !publicPattern.MatchString(s) {
			t.Fatalf("non DNS slug %q", s)
		}
	}
	for _, tt := range []struct{ name, want string }{{"原型发布工具", "yuanxingfabugongju"}, {"Hello World 2026", "hello-world-2026"}, {"中国React原型", "zhongguoreactyuanxing"}, {"😀 !!!", "project"}, {"A__ B---C", "a-b-c"}, {strings.Repeat("a", 100), strings.Repeat("a", 63)}} {
		if got := projectSlug(tt.name); got != tt.want {
			t.Errorf("%q got %q want %q", tt.name, got, tt.want)
		}
	}
}
func TestSlugCandidates(t *testing.T) {
	v := slugCandidates("demo")
	if len(v) != 1000 {
		t.Fatalf("candidate count %d", len(v))
	}
	want := []string{"demo", "demo111", "demo222", "demo333", "demo444", "demo555", "demo666", "demo777", "demo888", "demo999", "demo11"}
	for n, s := range want {
		if v[n] != s {
			t.Fatalf("candidate %d=%s want %s", n, v[n], s)
		}
	}
	if v[18] != "demo99" || v[19] != "demo1" || v[27] != "demo9" || v[28] != "demo10" {
		t.Fatalf("unexpected suffix order %v", v[:30])
	}
	seen := map[string]bool{}
	for _, s := range v {
		if seen[s] {
			t.Fatal("duplicate candidate", s)
		}
		seen[s] = true
	}
	if v[len(v)-1] != "demo998" {
		t.Fatal("last available suffix", v[len(v)-1])
	}
}
func TestSlugLengthAndLegacy(t *testing.T) {
	for _, s := range slugCandidates(strings.Repeat("a", 58) + "---") {
		if len(s) > 63 || !publicPattern.MatchString(s) {
			t.Fatal("invalid", s)
		}
	}
	if !publicPattern.MatchString(strings.Repeat("a", 32)) {
		t.Fatal("legacy link rejected")
	}
	for _, s := range []string{"a.b", "../a", "a/b", "-a", "a-", strings.Repeat("a", 64)} {
		if publicPattern.MatchString(s) {
			t.Fatal("unsafe slug accepted", s)
		}
	}
}
func TestSlugReservedAndURLs(t *testing.T) {
	t.Setenv("PUBLIC_URL_MODE", "subdomain")
	a := &app{domain: "localhost", scheme: "http", port: "8080"}
	for _, s := range []string{"admin", "api", "www", "console", "preview", "localhost", strings.Repeat("a", 32), "p-" + strings.Repeat("a", 32)} {
		if !a.reservedSlug(s) {
			t.Fatal("reserved not rejected", s)
		}
	}
	t.Setenv("ADMIN_HOSTS", "team.localhost")
	if !a.reservedSlug("team") {
		t.Fatal("admin hostname not reserved")
	}
	if a.url("youxiang") != "http://youxiang.localhost:8080/" {
		t.Fatal(a.url("youxiang"))
	}
	legacy := strings.Repeat("a", 32)
	if a.url(legacy) != "http://p-"+legacy+".localhost:8080/" {
		t.Fatal("legacy URL changed")
	}
	seen := map[string]bool{}
	for _, s := range slugCandidates(strings.Repeat("1", 63)) {
		if seen[s] {
			t.Fatal("duplicate truncated suffix")
		}
		seen[s] = true
	}
}
func TestPathURL(t *testing.T) {
	t.Setenv("PUBLIC_URL_MODE", "path")
	a := &app{domain: "byjin.cn", scheme: "https"}
	if got := a.url("youxiang"); got != "https://byjin.cn/youxiang/" {
		t.Fatal(got)
	}
	legacy := strings.Repeat("a", 32)
	if got := a.url(legacy); got != "https://p-"+legacy+".byjin.cn/" {
		t.Fatal(got)
	}
}
