package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAdaptPreservesInternalHashRouteRoundTrip(t *testing.T) {
	source := []byte("const routes=[{path:'/mobile/im/conversations'},{path:'/mobile/im/apps'}];function parse(hash){const name=hash.replace(/^#/, '').replace(/^\\//,'');const target=name.startsWith('mobile/')?`/${name}`:`/mobile/${name}`;return routes.some(r=>r.path===target)}function link(path){if(!routes.some(r=>r.path===path))throw Error('Unknown mobile route');return '#'+path.replace(/^\\/mobile\\//,'')}const next=link('/mobile/im/apps');if(!parse(next))throw Error('Unknown mobile route');const image='/mobile/im/apps/apps.svg';const dynamic=`/mobile/${'im'}/apps/apps.svg`;window.location.assign('/mobile/inbox');const view={href:'/?prototype=mobile-runtime',src:image};console.log(JSON.stringify({next,valid:parse(next),route:routes[1].path,image,dynamic,location:window.result,href:view.href}));")
	a := fixtureAdapter()
	out, err := a.javascript(source)
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for runtime route validation")
	}
	result, err := exec.Command(node, "-e", `globalThis.window={location:{assign:x=>window.result=x}};`+string(out)).CombinedOutput()
	if err != nil {
		t.Fatalf("route semantics changed: %s %v", result, err)
	}
	want := `{"next":"#im/apps","valid":true,"route":"/mobile/im/apps","image":"/tele/mobile/im/apps/apps.svg","dynamic":"/tele/mobile/im/apps/apps.svg","location":"/tele/mobile/inbox","href":"/tele/?prototype=mobile-runtime"}`
	if string(bytes.TrimSpace(result)) != want {
		t.Fatalf("unexpected routing/resource behavior: %s", result)
	}
	again, err := a.javascript(out)
	if err != nil || !bytes.Equal(out, again) {
		t.Fatalf("not idempotent: %v", err)
	}
	if bytes.Contains(source, []byte("/tele/")) {
		t.Fatal("input modified")
	}
}

func TestAdaptFileWithoutExtensionAndRouteWithExtension(t *testing.T) {
	a := fixtureAdapter()
	a.files = map[string]bool{"mobile/payload": true}
	source := []byte(`const payload='/mobile/payload',route='/mobile/contact/person.example',query='/?prototype=mobile-runtime';const link={href:route};console.log(JSON.stringify({payload,route,query,href:link.href}));`)
	out, err := a.javascript(source)
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for URL sink validation")
	}
	result, err := exec.Command(node, "-e", string(out)).CombinedOutput()
	if err != nil {
		t.Fatalf("generated script failed: %s %v", result, err)
	}
	want := `{"payload":"/tele/mobile/payload","route":"/mobile/contact/person.example","query":"/?prototype=mobile-runtime","href":"/tele/mobile/contact/person.example"}`
	if string(bytes.TrimSpace(result)) != want {
		t.Fatalf("unexpected URL sink behavior: %s", result)
	}
}

func TestAdaptRecordsFilesBeforeJavascript(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "mobile"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "mobile", "payload"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte(`<script src="/main.js"></script>`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.js"), []byte(`const payload='/mobile/payload';const routes=['/mobile/im/apps'];`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := adaptPathResources(root, "/fixture/"); err != nil {
		t.Fatal(err)
	}
	out, err := os.ReadFile(filepath.Join(root, "main.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "/fixture/mobile/payload") || strings.Contains(string(out), "/fixture/mobile/im/apps") {
		t.Fatalf("resource/route classification failed: %s", out)
	}
}
