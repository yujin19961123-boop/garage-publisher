package main

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShareTemplateEscaping(t *testing.T) {
	var b bytes.Buffer
	e := shareTemplate.Execute(&b, shareView{Items: []shareItem{{Name: `<script>alert(1)</script>`, URL: `javascript:alert(1)`}}, Count: 1})
	if e != nil {
		t.Fatal(e)
	}
	html := b.String()
	if strings.Contains(html, "<script>") || strings.Contains(html, "<img src=x") || strings.Contains(html, `href="javascript:`) {
		t.Fatal("unescaped content", html)
	}
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Fatal("name missing")
	}
}
func TestShareEmptyPage(t *testing.T) {
	var b bytes.Buffer
	shareTemplate.Execute(&b, shareView{})
	if !strings.Contains(b.String(), "暂无已发布原型") {
		t.Fatal("missing empty state")
	}
}
func TestShareInvalidRoutes(t *testing.T) {
	a := &app{}
	for _, p := range []string{"/_share/../secret/", "/_share/foo/bar/", "/_share/a./", "/_share/"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", p, nil)
		a.publicSharePage(w, r)
		if w.Code != 404 {
			t.Fatalf("%s status %d", p, w.Code)
		}
	}
	w := httptest.NewRecorder()
	a.publicSharePage(w, httptest.NewRequest("POST", "/_share/foo/", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("invalid method permitted")
	}
}
