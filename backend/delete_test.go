package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupIdentifierBounds(t *testing.T) {
	data := t.TempDir()
	good := strings.Repeat("a", 48)
	for _, bad := range []string{"", "..", "../outside", "/", "a", strings.Repeat("a", 47), strings.Repeat("A", 48), good + "/../"} {
		if _, e := cleanupTargets(data, bad, nil); e == nil {
			t.Fatalf("unsafe project identifier accepted %q", bad)
		}
		if _, e := cleanupTargets(data, good, []string{bad}); e == nil {
			t.Fatalf("unsafe deployment identifier accepted %q", bad)
		}
	}
	paths, e := cleanupTargets(data, good, []string{strings.Repeat("b", 48)})
	if e != nil || len(paths) != 5 {
		t.Fatalf("cleanup targets %v %v", paths, e)
	}
	for _, p := range paths {
		if p == data || !strings.HasPrefix(p, data+string(os.PathSeparator)) {
			t.Fatal("outside data", p)
		}
	}
}
func TestCleanupFilesIdempotentAndScoped(t *testing.T) {
	data := t.TempDir()
	id := strings.Repeat("a", 48)
	did := strings.Repeat("b", 48)
	other := strings.Repeat("c", 48)
	release := filepath.Join(data, "releases", id)
	keep := filepath.Join(data, "releases", other)
	stage := filepath.Join(data, "staging", did)
	uploads := filepath.Join(data, "uploads")
	for _, p := range []string{release, keep, stage, uploads} {
		os.MkdirAll(p, 0700)
	}
	os.WriteFile(filepath.Join(release, "index.html"), []byte("delete"), 0600)
	os.WriteFile(filepath.Join(keep, "index.html"), []byte("keep"), 0600)
	os.WriteFile(filepath.Join(uploads, did+".zip"), []byte("archive"), 0600)
	for n := 0; n < 2; n++ {
		if e := cleanupProjectFiles(data, id, []string{did}); e != nil {
			t.Fatal(e)
		}
	}
	for _, p := range []string{release, stage, filepath.Join(uploads, did+".zip")} {
		if _, e := os.Stat(p); !os.IsNotExist(e) {
			t.Fatal("not removed", p, e)
		}
	}
	if b, e := os.ReadFile(filepath.Join(keep, "index.html")); e != nil || string(b) != "keep" {
		t.Fatal("other project changed")
	}
	if _, e := os.Stat(data); e != nil {
		t.Fatal("data root removed")
	}
}
func TestCleanupRejectsSymlinks(t *testing.T) {
	data := t.TempDir()
	id := strings.Repeat("a", 48)
	outside := t.TempDir()
	os.MkdirAll(filepath.Join(data, "releases", id), 0700)
	os.WriteFile(filepath.Join(outside, "keep.txt"), []byte("keep"), 0600)
	link := filepath.Join(data, "releases", id, "link")
	if e := os.Symlink(outside, link); e != nil {
		t.Skip("symbolic link permission unavailable")
	}
	if e := cleanupProjectFiles(data, id, nil); e == nil {
		t.Fatal("cleanup accepted symlink")
	}
	if _, e := os.Stat(filepath.Join(outside, "keep.txt")); e != nil {
		t.Fatal("followed symlink")
	}
}
