package main

import (
	"net/http/httptest"
	"testing"
)

func TestSharedOriginRouting(t *testing.T) {
	a := &app{domain: "garage.byjin.cn", scheme: "https", port: "443"}
	t.Setenv("ADMIN_HOSTS", "garage.byjin.cn")
	t.Setenv("SHARED_ORIGIN", "true")
	for _, tt := range []struct {
		path, method, location string
		status                 int
	}{{"/", "GET", "", 404}, {"/api/v1/me", "GET", "", 401}, {"/api/v1/projects/x", "DELETE", "", 401}, {"/api", "GET", "", 404}, {"/api/v1", "GET", "", 404}, {"/youxiang", "GET", "/youxiang/", 301}, {"/youxiang/../escape", "GET", "", 400}, {"/_share/invalid.slug/", "GET", "", 404}, {"/_share/test/", "POST", "", 405}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(tt.method, "https://garage.byjin.cn"+tt.path, nil)
		a.ServeHTTP(w, r)
		if w.Code != tt.status || w.Header().Get("Location") != tt.location {
			t.Fatalf("%s %s: status=%d location=%s", tt.method, tt.path, w.Code, w.Header().Get("Location"))
		}
	}
}
func TestSharedOriginOptIn(t *testing.T) {
	a := &app{domain: "garage.byjin.cn", scheme: "https"}
	t.Setenv("ADMIN_HOSTS", "garage.byjin.cn")
	t.Setenv("SHARED_ORIGIN", "false")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, httptest.NewRequest("GET", "https://garage.byjin.cn/youxiang", nil))
	if w.Code != 404 {
		t.Fatal("same-origin public routing enabled without opt-in", w.Code)
	}
	t.Setenv("ADMIN_HOSTS", "console.byjin.cn")
	a.domain = "byjin.cn"
	w = httptest.NewRecorder()
	a.ServeHTTP(w, httptest.NewRequest("GET", "https://console.byjin.cn/api/v1/me", nil))
	if w.Code != 401 {
		t.Fatal("double-origin admin API changed", w.Code)
	}
	w = httptest.NewRecorder()
	a.ServeHTTP(w, httptest.NewRequest("GET", "https://console.byjin.cn/youxiang", nil))
	if w.Code != 404 {
		t.Fatal("public route on console domain", w.Code)
	}
}
func TestSharedOriginReservedSlugs(t *testing.T) {
	a := &app{domain: "garage.byjin.cn"}
	for _, s := range []string{"assets", "api", "healthz", "_share", "console", "favicon.ico", "favicon-ico"} {
		if !a.reservedSlug(s) {
			t.Fatal("platform path not reserved", s)
		}
	}
	if a.reservedSlug("youxiang") {
		t.Fatal("normal project name reserved")
	}
}
