package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExportedHTMLRoutes(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "docs"), 0700)
	os.WriteFile(filepath.Join(root, "about.html"), []byte("about"), 0600)
	os.WriteFile(filepath.Join(root, "docs", "index.html"), []byte("docs"), 0600)
	os.WriteFile(filepath.Join(root, "app.js.html"), []byte("must not hide missing JS"), 0600)
	for _, route := range []string{"/about", "/about/"} {
		file, info, err := resolveStaticPage(root, route)
		if err != nil || info.IsDir() || file != filepath.Join(root, "about.html") {
			t.Fatalf("%s did not resolve exported HTML: %s %v", route, file, err)
		}
	}
	_, info, err := resolveStaticPage(root, "/docs")
	if err != nil || !info.IsDir() {
		t.Fatal("directory redirect handling changed")
	}
	for _, route := range []string{"/app.js", "/missing"} {
		if _, _, err := resolveStaticPage(root, route); !os.IsNotExist(err) {
			t.Fatal("missing file should remain missing", route, err)
		}
	}
}
