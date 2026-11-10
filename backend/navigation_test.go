package main

import (
	"bytes"
	"os/exec"
	"testing"
)

func TestDynamicNavigation(t *testing.T) {
	a := fixtureAdapter()
	src := []byte(`let count=0;function url(){count++;return "/"+["mobile","inbox"].join("/")+"/"}const results=[];const window={location:{replace:x=>results.push(x),assign:x=>results.push(x)}};`)
	// A locally declared window is an ordinary object, not a browser global.
	shadowed, err := a.javascript(append(src, []byte(`window.location.replace(url());`)...))
	if err != nil || bytes.Contains(shadowed, []byte("__prototypeLocalURL_v1")) {
		t.Fatalf("shadowed browser global changed: %s %v", shadowed, err)
	}
	source := []byte(`let count=0;function url(){count++;return "/"+["mobile","inbox"].join("/")+"/"}window.location.replace(url());window.location.assign("/"+["api","save"].join("/"));window.location.href=url();const links={href:url(),src:(()=>"/icons/"+"a.svg")(),note:url()};console.log(JSON.stringify({count,replaced:window.replaced,assigned:window.assigned,href:window.location.href,links}));`)
	out, err := a.javascript(source)
	if err != nil || !bytes.Contains(out, []byte("__prototypeLocalURL_v1")) {
		t.Fatalf("navigation not adapted: %s %v", out, err)
	}
	again, err := a.javascript(out)
	if err != nil || !bytes.Equal(again, out) {
		t.Fatalf("navigation not idempotent: %v\n%s", err, again)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is needed for runtime semantics check")
	}
	setup := `globalThis.window={location:{replace:x=>window.replaced=x,assign:x=>window.assigned=x}};`
	result, err := exec.Command(node, "-e", setup+string(out)).CombinedOutput()
	if err != nil {
		t.Fatalf("generated JS failed: %s %v", result, err)
	}
	want := `{"count":4,"replaced":"/tele/mobile/inbox/","assigned":"/api/save","href":"/tele/mobile/inbox/","links":{"href":"/tele/mobile/inbox/","src":"/tele/icons/a.svg","note":"/mobile/inbox/"}}`
	if string(bytes.TrimSpace(result)) != want {
		t.Fatalf("unexpected runtime behavior: %s\n%s", result, out)
	}
}
