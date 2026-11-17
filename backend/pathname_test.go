package main

import (
	"bytes"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPathnameChecksPreserveURLAndInternalRoutes(t *testing.T) {
	a := fixtureAdapter()
	a.roots["pages"] = true
	source := []byte(`
globalThis.location=new URL('https://preview.example/tele/pages/owned/');
function pageURL(value){const url=new URL(value,location.origin),match=url.pathname.match(/^\/pages\/([a-z0-9-]+)(?:\/(?:index\.html)?)?$/);return url.origin===location.origin&&match?{name:match[1],href:url.href}:null}
const direct=new URL('/tele/pages/following/',location.origin);
const result={owned:pageURL('/tele/pages/owned/?filter=mine#tasks'),root:pageURL('/pages/owned/'),other:pageURL('/tele-other/pages/owned/'),external:pageURL('https://other.example/tele/pages/owned/'),bad:pageURL('/tele/pages/owned/extra'),test:/^\/pages\//.test(direct.pathname),exec:/^\/pages\/([a-z-]+)\/$/.exec(direct.pathname)[1],search:direct.pathname.search(/^\/pages\//),location:/^\/pages\//.test(location.pathname),matches:[...direct.pathname.matchAll(/^\/pages\/([a-z-]+)\//g)][0][1]};
const internal='/pages/owned/',business={pathname:'/tele/pages/owned/'};
result.internal=internal.replace(/^\/pages\//,'');result.business=business.pathname.match(/^\/pages\//);result.prefixed=direct.pathname.match(/^\/tele\/pages\/([a-z-]+)\/$/)[1];result.href=direct.href;
function shadow(URL){const local=new URL();return local.pathname.match(/^\/pages\//)}
result.shadow=shadow(function(){this.pathname='/tele/pages/owned/'});
console.log(JSON.stringify(result));`)
	out, err := a.javascript(source)
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for URL semantics regression")
	}
	actual, err := exec.Command(node, "-e", string(out)).CombinedOutput()
	if err != nil {
		t.Fatalf("adapted URL checks failed: %s %v", actual, err)
	}
	want := `{"owned":{"name":"owned","href":"https://preview.example/tele/pages/owned/?filter=mine#tasks"},"root":{"name":"owned","href":"https://preview.example/tele/pages/owned/"},"other":null,"external":null,"bad":null,"test":true,"exec":"following","search":0,"location":true,"matches":"following","internal":"owned/","business":null,"prefixed":"following","href":"https://preview.example/tele/pages/following/","shadow":null}`
	if string(bytes.TrimSpace(actual)) != want {
		t.Fatalf("URL/path semantics mismatch: %s", actual)
	}
	again, err := a.javascript(out)
	if err != nil || !bytes.Equal(out, again) {
		t.Fatalf("pathname adaptation is not idempotent: %v", err)
	}
	if bytes.Contains(source, []byte("__prototypePathname")) {
		t.Fatal("source modified")
	}
}

func TestPathnameReadsOnceAndIgnoresUnknownPatterns(t *testing.T) {
	a := fixtureAdapter()
	a.roots["pages"] = true
	source := []byte(`globalThis.location=new URL('https://preview.example/');let reads=0;const value={toString(){reads++;return '/tele/pages/owned/'}};const match=new URL(value,location.origin).pathname.match(/^\/pages\/([a-z-]+)\/$/);const uri=new URL('/tele/api/items',location.origin);console.log(JSON.stringify({reads,name:match[1],api:uri.pathname.match(/^\/api\//),unanchored:uri.pathname.match(/\/pages\//)}));`)
	out, err := a.javascript(source)
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required")
	}
	actual, err := exec.Command(node, "-e", string(out)).CombinedOutput()
	if err != nil || string(bytes.TrimSpace(actual)) != `{"reads":1,"name":"owned","api":null,"unanchored":null}` {
		t.Fatalf("side effect or unknown root changed: %s %v", actual, err)
	}
}

func TestBrowserURLConstructionPreservesExternalBases(t *testing.T) {
	a := fixtureAdapter()
	a.roots["pages"] = true
	source := []byte(`globalThis.location=new URL('https://preview.example/tele/pages/owned/');globalThis.window=globalThis;let reads=0;function destination(){reads++;return '/pages/desktop/?x=1#preview'}function localBase(location){return new URL('/pages/owned/',location.href).href}console.log(JSON.stringify({desktop:new URL('/pages/desktop/',location.href).href,dynamic:new URL(destination(),window.location.origin).href,reads,external:new URL('/pages/desktop/','https://external.example').href,absolute:new URL('https://external.example/pages/desktop/',location.origin).href,api:new URL('/api/items',location.origin).href,other:new URL('/tele-other/pages/owned/',location.href).href,shadowed:localBase({href:'https://external.example/'})}));`)
	out, err := a.javascript(source)
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required")
	}
	actual, err := exec.Command(node, "-e", string(out)).CombinedOutput()
	want := `{"desktop":"https://preview.example/tele/pages/desktop/","dynamic":"https://preview.example/tele/pages/desktop/?x=1#preview","reads":1,"external":"https://external.example/pages/desktop/","absolute":"https://external.example/pages/desktop/","api":"https://preview.example/api/items","other":"https://preview.example/tele-other/pages/owned/","shadowed":"https://external.example/pages/owned/"}`
	if err != nil || string(bytes.TrimSpace(actual)) != want {
		t.Fatalf("URL construction scope changed: %s %v", actual, err)
	}
	again, err := a.javascript(out)
	if err != nil || !bytes.Equal(out, again) {
		t.Fatal("URL constructor adaptation not idempotent", err)
	}
}

func TestLegacyURLConstructorWithoutPathname(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "pages"), 0700)
	filename := filepath.Join(root, "entry.js")
	source := []byte(`location.replace(new URL('/pages/desktop/',location.href).href);`)
	if err := os.WriteFile(filename, source, 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, _ := file.Stat()
	w := httptest.NewRecorder()
	if !servePrototypeWithPathnameCompatibility(w, httptest.NewRequest("GET", "/tele/entry.js", nil), file, info, root, "/tele") || !strings.Contains(w.Body.String(), "/tele/pages/desktop/") {
		t.Fatal("legacy URL constructor without pathname was not adapted")
	}
	after, _ := os.ReadFile(filename)
	if !bytes.Equal(source, after) {
		t.Fatal("legacy entry rewritten on disk")
	}
}

func TestLegacyPathnameResponseIsImmutableAndSupportsHTTP(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "pages"), 0700)
	filename := filepath.Join(root, "desktop.js")
	source := []byte(`const url=new URL(location.href);console.log(url.pathname.match(/^\/pages\/([a-z-]+)\/$/));`)
	if err := os.WriteFile(filename, source, 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, _ := file.Stat()
	serve := func(method string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/tele/desktop.js", nil)
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		if !servePrototypeWithPathnameCompatibility(w, r, file, info, root, "/tele") {
			t.Fatal("legacy response not adapted")
		}
		return w
	}
	full := serve("GET", map[string]string{"If-Modified-Since": time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)})
	if full.Code != 200 || !strings.Contains(full.Body.String(), "__prototypePathname_v1") || full.Header().Get("Last-Modified") != "" {
		t.Fatal("legacy code must not be served as unchanged", full.Code)
	}
	if full.Header().Get("Content-Length") != strconv.Itoa(full.Body.Len()) {
		t.Fatal("wrong transformed content length")
	}
	head := serve("HEAD", nil)
	if head.Body.Len() != 0 || head.Header().Get("Content-Length") != full.Header().Get("Content-Length") {
		t.Fatal("HEAD differs from GET representation")
	}
	part := serve("GET", map[string]string{"Range": "bytes=0-15"})
	if part.Code != 206 || part.Body.String() != full.Body.String()[:16] {
		t.Fatal("range does not refer to adapted representation")
	}
	after, _ := os.ReadFile(filename)
	if sha256.Sum256(source) != sha256.Sum256(after) {
		t.Fatal("published file modified")
	}
	w := httptest.NewRecorder()
	if servePrototypeWithPathnameCompatibility(w, httptest.NewRequest("GET", "/desktop.js", nil), file, info, root, "") {
		t.Fatal("subdomain serving changed")
	}
}

func TestPathnameCompatibilityInPublishedPreview(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	id := f.seedRelease(1, false)
	f.current(id)
	root := filepath.Join(f.a.data, "releases", f.pid, id)
	os.MkdirAll(filepath.Join(root, "pages"), 0700)
	source := []byte(`const url=new URL(location.href);console.log(url.pathname.match(/^\/pages\/([a-z-]+)\/$/));`)
	if err := os.WriteFile(filepath.Join(root, "desktop.js"), source, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, versionManifestName)); err != nil {
		t.Fatal(err)
	}
	if err := writeVersionManifest(root); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	f.a.pathPreview(w, httptest.NewRequest("GET", "http://localhost:8080/version-fixture/desktop.js", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "__prototypePathname_v1") {
		t.Fatalf("published preview did not apply compatibility: %d %s", w.Code, w.Body.String())
	}
	after, _ := os.ReadFile(filepath.Join(root, "desktop.js"))
	if !bytes.Equal(source, after) || f.scalar("SELECT count(*) FROM projects WHERE id=$1 AND current_release_id=$2", f.pid, id) != 1 {
		t.Fatal("release or current version changed")
	}
}
