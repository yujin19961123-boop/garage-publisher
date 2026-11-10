package main

import (
	"net/http"
	"net/http/httptest"

	"testing"
)

func TestPathRedirects(t *testing.T) {
	a := &app{domain: "localhost", scheme: "http", port: "8080"}
	t.Setenv("CONSOLE_URL", "http://console.localhost:8080/")
	for _, tt := range []struct {
		url, location string
		status        int
	}{{"http://localhost/", "http://console.localhost:8080/", 307}, {"http://localhost/youxiang", "/youxiang/", 301}, {"http://localhost/youxiang/../escape", "", 400}, {"http://localhost/youxiang//escape", "", 400}, {"http://localhost/youxiang%5Cescape/", "", 400}} {
		r := httptest.NewRequest(http.MethodGet, tt.url, nil)
		w := httptest.NewRecorder()
		a.pathPreview(w, r)
		if w.Code != tt.status || w.Header().Get("Location") != tt.location {
			t.Fatalf("%s: status %d loc %s", tt.url, w.Code, w.Header().Get("Location"))
		}
	}
}
