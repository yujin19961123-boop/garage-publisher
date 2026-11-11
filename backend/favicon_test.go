package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/html"
)

// Inspect real link tokens; icon-looking strings in script/comment text do not
// count as document declarations.
func garageFaviconLinks(data []byte) int {
	z := html.NewTokenizer(bytes.NewReader(data))
	count := 0
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			return count
		}
		if tt != html.StartTagToken && tt != html.SelfClosingTagToken {
			continue
		}
		token := z.Token()
		if token.Data != "link" {
			continue
		}
		for _, a := range token.Attr {
			if a.Key == "href" && strings.HasSuffix(a.Val, "/.garage-favicon.svg") {
				count++
			}
		}
	}
}
func documentType(data []byte) string {
	z := html.NewTokenizer(bytes.NewReader(data))
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			return ""
		}
		if tt == html.DoctypeToken {
			return z.Token().String()
		}
	}
}

func TestPrototypeFaviconPreservesAuthorDeclaration(t *testing.T) {
	for _, source := range []string{
		`<!DOCTYPE html><html><head><link rel="icon" href="/my-icon.ico"></head><body>hello</body></html>`,
		`<html><HEAD><LINK REL="ICON" HREF="https://cdn.example/icon.png"></HEAD><body>hello</body></html>`,
		`<head><link rel="SHORTCUT ICON" href="./brand.svg"></head><body>hello</body>`,
		`<head><link rel="icon" href="data:image/svg+xml;base64,PHN2Zy8+"></head>`,
		`<head><link rel="icon" href="data:,"><link rel="icon" href="/author.png"></head>`,
	} {
		input := []byte(source)
		out, changed := withPrototypeFavicon(input, "/demo", false)
		if changed || !bytes.Equal(input, out) {
			t.Fatalf("author declaration changed: %s", out)
		}
		if !bytes.Equal(input, []byte(source)) {
			t.Fatal("input slice mutated")
		}
	}
}

func TestPrototypeFaviconAddsOnlyWhenMissing(t *testing.T) {
	for _, source := range []string{
		`<!doctype html><html><head><title>Example</title></head><body><p>hello</p></body></html>`,
		`<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head></head><body>legacy</body></html>`,
		`<html><head></head><body>quirks</body></html>`,
		`<html><body>no explicit head</body></html>`,
		`<p>minimal html</p>`,
		`<!doctype html><p>minimal standards html</p>`,
		`<html><HEAD><TITLE>case</TITLE></HEAD><BODY>ok</BODY></html>`,
	} {
		input := []byte(source)
		out, changed := withPrototypeFavicon(input, "/deep-project", false)
		if !changed {
			t.Fatalf("missing favicon not inserted for %s", source)
		}
		if garageFaviconLinks(out) != 1 {
			t.Fatalf("expected one injected declaration: %s", out)
		}
		if !bytes.Contains(out, []byte(`/deep-project/.garage-favicon.svg`)) {
			t.Fatal("favicon URL lost absolute project prefix", string(out))
		}
		if documentType(out) != documentType(input) {
			t.Fatal("doctype/quirks declaration changed", string(out))
		}
		if strings.HasPrefix(strings.ToLower(source), "<!doctype") {
			end := strings.IndexByte(source, '>') + 1
			if !bytes.HasPrefix(out, input[:end]) {
				t.Fatal("doctype moved behind injected markup", string(out))
			}
		}
		if !bytes.Equal(input, []byte(source)) {
			t.Fatal("original HTML slice mutated")
		}
		again, changed := withPrototypeFavicon(out, "/deep-project", false)
		if changed || !bytes.Equal(again, out) {
			t.Fatal("favicon injection is not idempotent")
		}
	}
}

func TestPrototypeFaviconReplacesEmptyNextIcon(t *testing.T) {
	for _, source := range []string{`<head><link rel="icon" href="data:,"></head>`, `<head><link rel="icon" href=""></head>`, `<HEAD><LINK REL="shortcut icon" HREF="data:,"></HEAD>`} {
		out, changed := withPrototypeFavicon([]byte(source), "/next-prototype", false)
		if !changed || garageFaviconLinks(out) != 1 || !bytes.Contains(out, []byte(`/next-prototype/.garage-favicon.svg`)) {
			t.Fatal("empty icon not replaced", string(out))
		}
	}
}

func TestPrototypeFaviconIgnoresFakeTags(t *testing.T) {
	source := `<!doctype html><html><head><!-- </head><link rel="icon" href="/fake.ico"> --><script>const fake="</head><link rel='icon' href='/fake2.ico'>";</script><title>Real</title></head><body>body</body></html>`
	out, changed := withPrototypeFavicon([]byte(source), "/demo", false)
	if !changed || garageFaviconLinks(out) != 1 {
		t.Fatal("fake script/comment icon blocked injection", string(out))
	}
	if !bytes.Contains(out, []byte(`const fake="</head><link rel='icon' href='/fake2.ico'>";`)) {
		t.Fatal("inline script was modified")
	}
}

func TestPrototypeFaviconTruncatedHeadUnchanged(t *testing.T) {
	for _, source := range []string{`<!doctype html><html><head><script>let x="</head>";`, `<html><head><title>long title`, `<!-- not enough to identify the document -->`} {
		input := []byte(source)
		out, changed := withPrototypeFavicon(input, "/demo", true)
		if changed || !bytes.Equal(input, out) {
			t.Fatal("incomplete truncated prefix was modified", string(out))
		}
	}
	completeHead := []byte(`<html><head></head><body>partial body`)
	out, changed := withPrototypeFavicon(completeHead, "", true)
	if !changed || !bytes.Contains(out, []byte(`/.garage-favicon.svg`)) {
		t.Fatal("complete head within truncated sample should be adapted")
	}
}

func faviconReadSeekerFixture() (*prefixReadSeeker, *bytes.Reader, []byte, []byte) {
	originalPrefix := []byte("<!doctype html><head></head>")
	original := append(append([]byte{}, originalPrefix...), bytes.Repeat([]byte("TAIL-0123456789\n"), 180000)...)
	prefix := []byte("<!doctype html><head><link rel=icon href=/demo/.garage-favicon.svg></head>")
	source := bytes.NewReader(original)
	source.Seek(5, io.SeekStart)
	reader := &prefixReadSeeker{prefix: prefix, source: source, originalPrefixSize: int64(len(originalPrefix)), originalSize: int64(len(original)), position: 0}
	expected := append(append([]byte{}, prefix...), original[len(originalPrefix):]...)
	return reader, source, expected, original
}

func TestPrototypePrefixReadSeekerReadAndSeek(t *testing.T) {
	r, source, want, original := faviconReadSeekerFixture()
	backup := append([]byte{}, original...)
	got, e := io.ReadAll(r)
	if e != nil || !bytes.Equal(got, want) {
		t.Fatal("full transformed HTML/tail mismatch", e, len(got), len(want))
	}
	if position, e := source.Seek(0, io.SeekCurrent); e != nil || position != 5 {
		t.Fatal("ReaderAt source seek position changed", position, e)
	}
	if !bytes.Equal(original, backup) {
		t.Fatal("source bytes mutated")
	}
	for _, tc := range []struct {
		offset int64
		whence int
		count  int
	}{{0, io.SeekStart, 16}, {int64(len(r.prefix) - 4), io.SeekStart, 16}, {-17, io.SeekEnd, 17}, {0, io.SeekStart, 1}} {
		position, e := r.Seek(tc.offset, tc.whence)
		if e != nil {
			t.Fatal(e)
		}
		buf := make([]byte, tc.count)
		n, e := io.ReadFull(r, buf)
		if e != nil || !bytes.Equal(buf[:n], want[int(position):int(position)+n]) {
			t.Fatal("seek/read mismatch", position, n, e)
		}
	}
	if _, e := r.Seek(-1, io.SeekStart); e == nil {
		t.Fatal("negative seek accepted")
	}
	if _, e := r.Seek(0, 77); e == nil {
		t.Fatal("invalid seek origin accepted")
	}
}

func TestPrototypePrefixReadSeekerServeContent(t *testing.T) {
	_, _, expected, _ := faviconReadSeekerFixture()
	for _, tc := range []struct {
		method, rangeHeader string
		status              int
		start, end          int
	}{{"GET", "", 200, 0, len(expected)}, {"HEAD", "", 200, 0, 0}, {"GET", "bytes=0-12", 206, 0, 13}, {"GET", "bytes=60-95", 206, 60, 96}, {"GET", "bytes=-17", 206, len(expected) - 17, len(expected)}} {
		t.Run(tc.method+tc.rangeHeader, func(t *testing.T) {
			reader, source, want, original := faviconReadSeekerFixture()
			backup := append([]byte{}, original...)
			req := httptest.NewRequest(tc.method, "http://localhost:8080/demo/deep/page.html", nil)
			if tc.rangeHeader != "" {
				req.Header.Set("Range", tc.rangeHeader)
			}
			w := httptest.NewRecorder()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			http.ServeContent(w, req, "index.html", time.Time{}, reader)
			if w.Code != tc.status {
				t.Fatal("ServeContent status", w.Code, w.Body.String())
			}
			if !bytes.Equal(w.Body.Bytes(), want[tc.start:tc.end]) {
				t.Fatal("ServeContent body mismatch")
			}
			length := tc.end - tc.start
			if tc.method == "HEAD" {
				length = len(want)
			}
			if w.Header().Get("Content-Length") != strconv.Itoa(length) {
				t.Fatal("Content-Length mismatch", w.Header().Get("Content-Length"), length)
			}
			if tc.status == 206 && w.Header().Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", tc.start, tc.end-1, len(want)) {
				t.Fatal("Content-Range mismatch", w.Header().Get("Content-Range"))
			}
			if p, _ := source.Seek(0, io.SeekCurrent); p != 5 {
				t.Fatal("ServeContent changed source position")
			}
			if !bytes.Equal(original, backup) {
				t.Fatal("ServeContent mutated disk/source data")
			}
		})
	}
}

func TestPrototypeFaviconDoesNotModifySourceFiles(t *testing.T) {
	dir := t.TempDir()
	source := []byte(`<!doctype html><html><head></head><body>original release</body></html>`)
	htmlPath := filepath.Join(dir, "index.html")
	manifestPath := filepath.Join(dir, ".garage-manifest.json")
	manifest := []byte(`{"files":[{"path":"index.html","size":82,"sha256":"unchanged-test-placeholder"}]}`)
	if e := os.WriteFile(htmlPath, source, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(manifestPath, manifest, 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(htmlPath)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	adapted, changed := withPrototypeFavicon(source, "/demo", false)
	if !changed {
		t.Fatal("fixture favicon not injected")
	}
	reader := &prefixReadSeeker{prefix: adapted, source: f, originalPrefixSize: int64(len(source)), originalSize: int64(len(source))}
	w := httptest.NewRecorder()
	http.ServeContent(w, httptest.NewRequest("GET", "http://localhost:8080/demo/", nil), "index.html", time.Time{}, reader)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), adapted) {
		t.Fatal("unexpected HTML response")
	}
	for _, tt := range []struct {
		file string
		want []byte
	}{{htmlPath, source}, {manifestPath, manifest}} {
		got, e := os.ReadFile(tt.file)
		if e != nil || !bytes.Equal(got, tt.want) {
			t.Fatal("published source/manifest changed", tt.file, e)
		}
	}
}
