package main

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

func TestOriginalViteHelper(t *testing.T) {
	filename := os.Getenv("ORIGINAL_DIST_ZIP")
	if filename == "" {
		t.Skip("set ORIGINAL_DIST_ZIP to verify uploaded fixture")
	}
	z, e := zip.OpenReader(filename)
	if e != nil {
		t.Fatal(e)
	}
	defer z.Close()
	found := 0
	for _, f := range z.File {
		if !strings.HasSuffix(f.Name, ".js") {
			continue
		}
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		data, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Contains(data, []byte("__vite__mapDeps")) || !bytes.Contains(data, []byte("vite:preloadError")) {
			continue
		}
		out, e := fixtureAdapter().javascript(data)
		if e != nil {
			t.Fatal(f.Name, e)
		}
		if bytes.Equal(data, out) || !bytes.Contains(out, []byte("/tele/")) {
			t.Fatal("actual Vite helper unchanged", f.Name)
		}
		again, e := fixtureAdapter().javascript(out)
		if e != nil || !bytes.Equal(out, again) {
			t.Fatal("actual bundle not idempotent", f.Name, e)
		}
		found++
		t.Log("adapted actual Vite preload module", f.Name)
	}
	if found == 0 {
		t.Fatal("no Vite preload module in fixture")
	}
}

func TestAdaptVitePreloader(t *testing.T) {
	for _, helper := range []string{"function(e){return '/' + e}", "e=>'/' + e", "e=>`/${e}`", "function(e){return `/`+e}"} {
		src := []byte("const __vite__mapDeps=i=>i;const join=" + helper + ";function preload(e){document.querySelector('meta[property=csp-nonce]');const p=join(e);dispatchEvent(new Event('vite:preloadError'));return p};const untouched='/';const normal=e=>'/' + e;")
		out, e := fixtureAdapter().javascript(src)
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Contains(out, []byte("/tele/")) {
			t.Fatalf("helper not adapted %s: %s", helper, out)
		}
		if !strings.Contains(string(out), `untouched = '/'`) || !strings.Contains(string(out), `return '/' + e;`) {
			t.Fatalf("unrelated roots modified %s", out)
		}
		again, e := fixtureAdapter().javascript(out)
		if e != nil || !bytes.Equal(out, again) {
			t.Fatal("Vite adaptation not idempotent", e)
		}
	}
}
func TestAdaptViteNoFalsePositive(t *testing.T) {
	for _, s := range []string{"const join=e=>'/' + e;function preload(e){return join(e)}", "const __vite__mapDeps=i=>i;const join=e=>'/' + e;const err='vite:preloadError';", "const __vite__mapDeps=i=>i;const join=e=>'./' + e;function preload(e){document.querySelector('meta[property=csp-nonce]');dispatchEvent(new Event('vite:preloadError'));return join(e)}"} {
		src := []byte(s)
		out, e := fixtureAdapter().javascript(src)
		if e != nil || !bytes.Equal(src, out) {
			t.Fatalf("changed unrelated/relative helper: %s %v", out, e)
		}
	}
}
