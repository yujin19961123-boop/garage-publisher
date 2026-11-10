package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
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
	if err := shareTemplate.Execute(&b, shareView{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), "暂无已发布原型") {
		t.Fatal("missing empty state")
	}
}

func TestShareInteractionPolicy(t *testing.T) {
	var b bytes.Buffer
	if err := shareTemplate.Execute(&b, shareView{Items: []shareItem{{Name: `</script><script>alert(1)</script>`, URL: `https://example.com/demo/`}}, Count: 1}); err != nil {
		t.Fatal(err)
	}
	html := b.String()
	const start = `<script type="module">`
	if strings.Count(html, start) != 1 || strings.Count(html, "</script>") != 1 {
		t.Fatal("untrusted content created an executable script")
	}
	_, script, _ := strings.Cut(html, start)
	script, _, _ = strings.Cut(script, "</script>")
	hash := sha256.Sum256([]byte(script))
	policy := shareCSP()
	if !strings.Contains(policy, "script-src 'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'") {
		t.Fatal("rendered interaction script does not match CSP")
	}
	if strings.Contains(policy, "script-src 'unsafe-inline'") || strings.Contains(policy, "script-src 'self'") {
		t.Fatal("collection must only execute the platform's exact embedded script")
	}
	if !strings.Contains(html, `class="project-grid single"`) || !strings.Contains(html, `rel="noopener noreferrer"`) {
		t.Fatal("single project layout or safe link handling missing")
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
