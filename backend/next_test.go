package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
	"os"
	"path/filepath"
	"testing"
)

func TestNextFlightTextLengthRecord(t *testing.T) {
	text := `a note: "/_next/static/user-text.css"`
	payload := fmt.Sprintf("1:T%x,%s\n:HL[\"/_next/static/css/real.css\",\"style\"]", len(text), text)
	out, changed := adaptNextFlightPayload(payload, "/laobaby/")
	if !changed || !bytes.Contains([]byte(out), []byte(text)) || !bytes.Contains([]byte(out), []byte("/laobaby/_next/static/css/real.css")) {
		t.Fatal("text record corrupted", out)
	}
}

func TestNextExportTextPayloads(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "_next"), 0700)
	os.WriteFile(filepath.Join(root, "index.html"), []byte(`<script>self.__next_f=[]</script>`), 0600)
	payload := []byte(":HL[\"/_next/static/css/a.css\",\"style\"]\n")
	for _, name := range []string{"index.txt", "zh-CN.txt", "__next._full.txt", "__next.special"} {
		os.WriteFile(filepath.Join(root, name), payload, 0600)
	}
	yes, e := isNextStaticExport(root)
	if e != nil || !yes {
		t.Fatal("Next not detected", e)
	}
	if e = adaptNextStaticPayloads(root, "/laobaby/"); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"index.txt", "zh-CN.txt", "__next._full.txt", "__next.special"} {
		data, _ := os.ReadFile(filepath.Join(root, name))
		if !bytes.Contains(data, []byte("/laobaby/_next/static/css/a.css")) {
			t.Fatal("payload unchanged", name)
		}
	}
	if e = adaptNextStaticPayloads(root, "/laobaby/"); e != nil {
		t.Fatal(e)
	}
	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "index.txt"), payload, 0600)
	if e = adaptNextStaticPayloads(other, "/other/"); e != nil {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(filepath.Join(other, "index.txt"))
	if !bytes.Equal(data, payload) {
		t.Fatal("non-Next text changed")
	}
}
func TestResolveNextStaticPayload(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "_next"), 0700)
	os.WriteFile(filepath.Join(root, "index.html"), []byte(`<script>self.__next_f=[]</script>`), 0600)
	route := "zh-CN/web/mail/inbox"
	nested := filepath.Join(root, filepath.FromSlash(route), "__next.$d$locale", "web", "mail", "inbox", "__PAGE__.txt")
	os.MkdirAll(filepath.Dir(nested), 0700)
	os.WriteFile(nested, []byte("payload"), 0600)
	existing := filepath.Join(root, filepath.FromSlash(route), "__next._tree.txt")
	os.WriteFile(existing, []byte("tree"), 0600)
	for _, tt := range []struct {
		raw, want string
		ok        bool
	}{{"/" + route + "/__next.$d$locale.web.mail.inbox.__PAGE__.txt", nested, true}, {"/" + route + "/__next.$d$locale/web/mail/inbox/__PAGE__.txt", nested, true}, {"/" + route + "/__next._tree.txt", existing, true}, {"/" + route + "/__next.$d$locale.web.mail.inbox.MISSING.txt", "", false}, {"/" + route + "/ordinary.web.mail.inbox.txt", "", false}, {"/" + route + "/__next.$d$locale..web.txt", "", false}, {"/" + route + "/__next..hidden.txt", "", false}, {"/../outside/__next.a.b.txt", "", false}, {"//outside/__next.a.b.txt", "", false}, {"/" + route + "/__next.a.%2e%2e.txt", "", false}, {"/" + route + "/__next.a.b.txt?x=1", "", false}, {"/" + route + "/__next.a.\\evil.txt", "", false}} {
		t.Run(tt.raw, func(t *testing.T) {
			file, info, e := resolveNextStaticPayload(root, tt.raw)
			if (e == nil) != tt.ok {
				t.Fatalf("file=%s error=%v", file, e)
			}
			if tt.ok && (file != tt.want || info == nil) {
				t.Fatalf("got %s want %s", file, tt.want)
			}
		})
	}
	os.RemoveAll(filepath.Join(root, "_next"))
	if _, _, e := resolveNextStaticPayload(root, "/"+route+"/__next.$d$locale.web.mail.inbox.__PAGE__.txt"); e == nil {
		t.Fatal("alias enabled for non-Next directory")
	}
}

func nextAdaptSource(t *testing.T, source string) (string, bool) {
	t.Helper()
	ast, e := js.Parse(parse.NewInputBytes([]byte(source)), js.Options{})
	if e != nil {
		t.Fatal(e)
	}
	changed := adaptNextRuntime(ast, []byte(source), "/laobaby/")
	if !changed {
		return source, false
	}
	var b bytes.Buffer
	ast.JS(&b)
	if _, e = js.Parse(parse.NewInputBytes(b.Bytes()), js.Options{}); e != nil {
		t.Fatal("invalid resulting script", e)
	}
	return b.String(), true
}
func TestNextFlightNestedResources(t *testing.T) {
	payload := "1:\"$Sreact.fragment\"\n:HL[\"/_next/static/css/a.css\",\"style\"]\n0:{\"c\":[\"\",\"zh-CN\"],\"href\":\"/_next/static/chunks/a.js\",\"text\":\"see /_next/static/x\",\"external\":\"https://cdn/_next/a\"}"
	encoded, _ := json.Marshal(payload)
	source := "self.__next_f.push([1," + string(encoded) + "]);const unrelated='/_next/not-a-flight.js';const re=/\\/_next\\//;"
	out, changed := nextAdaptSource(t, source)
	if !changed {
		t.Fatal("Flight not adapted")
	}
	if !bytes.Contains([]byte(out), []byte("/laobaby/_next/static/css/a.css")) || !bytes.Contains([]byte(out), []byte("/laobaby/_next/static/chunks/a.js")) {
		t.Fatal(out)
	}
	if !bytes.Contains([]byte(out), []byte("see /_next/static/x")) || !bytes.Contains([]byte(out), []byte("https://cdn/_next/a")) || !bytes.Contains([]byte(out), []byte("'/_next/not-a-flight.js'")) {
		t.Fatal("modified unrelated content", out)
	}
	again, changed := nextAdaptSource(t, out)
	if changed || again != out {
		t.Fatal("not idempotent")
	}
}
func TestNextFlightOnlyKnownPushShape(t *testing.T) {
	for _, source := range []string{`const x="/_next/a";`, `other.__next_f.push([1,"\"/_next/a\""]);`, `self.__next_f.push([0,"\"/_next/a\""]);`, `self.__next_f.push([1,"ordinary /_next/a text"]);`} {
		out, changed := nextAdaptSource(t, source)
		if changed || out != source {
			t.Fatal("false positive", out)
		}
	}
}
func TestNextFlightPayloadEscapeSafety(t *testing.T) {
	payload := "1:{\"href\":\"/_next/static/a\\\"b.css\",\"text\":\"</script><img src=x>\"}"
	out, changed := adaptNextFlightPayload(payload, "/laobaby/")
	if !changed {
		t.Fatal("not adapted")
	}
	if !bytes.Contains([]byte(out), []byte("/laobaby/_next/static/")) {
		t.Fatal(out)
	}
	if out2, changed := adaptNextFlightPayload(out, "/laobaby/"); changed || out2 != out {
		t.Fatal("not idempotent")
	}
}
