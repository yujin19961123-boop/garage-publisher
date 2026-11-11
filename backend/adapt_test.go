package main

import (
	"bytes"
	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureAdapter() pathAdapter {
	return pathAdapter{prefix: "/tele/", roots: map[string]bool{"assets": true, "mail": true, "mobile": true, "icons": true, "avatars": true}}
}
func TestAdaptJavaScript(t *testing.T) {
	a := fixtureAdapter()
	src := []byte("const a='/mail/a.svg', b=`/mobile/${x}/a.png`, c='/#inbox', d='/?prototype=1'; const re=/\\/assets\\/\\w+/g; const url='https://a.com/assets/x'; const cdn='//cdn/a'; const api='/api/x'; const relative='./assets/a.js';")
	out, e := a.javascript(src)
	if e != nil {
		t.Fatal(e)
	}
	for _, want := range []string{"/tele/mail/a.svg", "`/tele/mobile/${x}/a.png`", "/#inbox", "/?prototype=1", `/\/assets\/\w+/g`, "https://a.com/assets/x", "//cdn/a", "/api/x", "./assets/a.js"} {
		if !bytes.Contains(out, []byte(want)) {
			t.Fatalf("missing %s in %s", want, out)
		}
	}
	if _, e = js.Parse(parse.NewInputBytes(out), js.Options{}); e != nil {
		t.Fatal("invalid resulting JS", e)
	}
	again, e := a.javascript(out)
	if e != nil || !bytes.Equal(out, again) {
		t.Fatalf("not idempotent %v", e)
	}
	if bytes.Contains(src, []byte("/tele/")) {
		t.Fatal("mutated original input")
	}
}
func TestAdaptCSS(t *testing.T) {
	out, e := fixtureAdapter().stylesheet([]byte(`a{background:url(/mail/a.svg)}b{src:url('/assets/a.woff')}c{background:url(https://a.com/x)}d{background:url(data:image/png;base64,abc)}e{background:url(//cdn/x)}`))
	if e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{"url(/tele/mail/a.svg)", "url('/tele/assets/a.woff')", "url(https://a.com/x)", "url(data:image/png;base64,abc)", "url(//cdn/x)"} {
		if !strings.Contains(string(out), s) {
			t.Fatal("missing", s, string(out))
		}
	}
}
func TestAdaptHTML(t *testing.T) {
	src := []byte(`<html><head><base href="/"><script src="/assets/main.js" integrity="old"></script><script src="https://cdn/x.js" integrity="keep"></script><style>a{background:url(/mail/a.svg)}</style></head><body style="background:url(/icons/a.svg)"><script>let a='/avatars/a.png';</script><script type="application/json">{"path":"/mail/no"}</script><a href="/#inbox">open</a></body></html>`)
	out, e := fixtureAdapter().markup(src)
	if e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{`href="/tele/"`, `src="/tele/assets/main.js"`, `integrity="keep"`, "/tele/mail/a.svg", "/tele/icons/a.svg", "/tele/avatars/a.png", `{"path":"/mail/no"}`, `href="/tele/#inbox"`} {
		if !strings.Contains(string(out), s) {
			t.Fatalf("missing %s: %s", s, out)
		}
	}
	if strings.Contains(string(out), `integrity="old"`) {
		t.Fatal("stale integrity")
	}
	again, e := fixtureAdapter().markup(out)
	if e != nil || !bytes.Equal(out, again) {
		t.Fatalf("HTML not idempotent %v", e)
	}
}

func TestNextDefaultFaviconStaysWithinExport(t *testing.T) {
	a := fixtureAdapter()
	source := []byte(`<html><head><title>Next</title></head><body><script>self.__next_f=[];</script></body></html>`)
	out, err := a.markup(source)
	if err != nil || !bytes.Contains(out, []byte(`rel="icon" href="data:,"`)) {
		t.Fatalf("missing local favicon fallback: %s %v", out, err)
	}
	again, err := a.markup(out)
	if err != nil || !bytes.Equal(out, again) {
		t.Fatal("favicon fallback is not idempotent", err)
	}
	explicit := []byte(`<html><head><link rel="icon" href="/icons/a.svg"></head><script>self.__next_f=[];</script></html>`)
	out, err = a.markup(explicit)
	if err != nil || bytes.Contains(out, []byte("data:,")) || !bytes.Contains(out, []byte("/tele/icons/a.svg")) {
		t.Fatalf("explicit icon replaced: %s %v", out, err)
	}
}
func TestAdaptStagingOnly(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "old")
	stage := filepath.Join(root, "stage")
	os.Mkdir(old, 0700)
	os.Mkdir(stage, 0700)
	os.Mkdir(filepath.Join(stage, "assets"), 0700)
	original := []byte(`const x="/assets/image.png";`)
	os.WriteFile(filepath.Join(old, "main.js"), original, 0600)
	os.WriteFile(filepath.Join(stage, "main.js"), original, 0600)
	if e := adaptPathResources(stage, "/tele/"); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(filepath.Join(old, "main.js"))
	if !bytes.Equal(b, original) {
		t.Fatal("published directory changed")
	}
	b, _ = os.ReadFile(filepath.Join(stage, "main.js"))
	if !bytes.Contains(b, []byte("/tele/assets/image.png")) {
		t.Fatal("staging not adapted")
	}
}
func TestAdaptInvalidJavaScript(t *testing.T) {
	if _, e := fixtureAdapter().javascript([]byte("const = !!!")); e == nil {
		t.Fatal("accepted invalid script")
	}
}
func TestAdaptModuleImports(t *testing.T) {
	src := []byte(`import x from "/assets/x.js"; export {x} from '/assets/y.js'; import "/assets/z.js";`)
	out, e := fixtureAdapter().javascript(src)
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{"/tele/assets/x.js", "/tele/assets/y.js", "/tele/assets/z.js"} {
		if !bytes.Contains(out, []byte(p)) {
			t.Fatal("missing adapted import", string(out))
		}
	}
}
func TestAdaptCSSImportAndSrcset(t *testing.T) {
	a := fixtureAdapter()
	out, e := a.stylesheet([]byte(`@import "/assets/main.css"; a{content:"/assets/leave.txt"}`))
	if e != nil || !bytes.Contains(out, []byte("/tele/assets/main.css")) || !bytes.Contains(out, []byte(`content:"/assets/leave.txt"`)) {
		t.Fatalf("CSS import/content %s %v", out, e)
	}
	got := a.srcset("/mail/a.png 1x, /mail/b.png 2x, https://cdn/x 3x")
	if got != "/tele/mail/a.png 1x, /tele/mail/b.png 2x, https://cdn/x 3x" {
		t.Fatal(got)
	}
	data := "data:image/png;base64,abc 1x"
	if a.srcset(data) != data {
		t.Fatal("changed data URL")
	}
}
