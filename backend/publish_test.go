package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func makeArchive(t *testing.T, names []string) string {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, n := range names {
		f, e := z.Create(n)
		if e != nil {
			t.Fatal(e)
		}
		f.Write([]byte("hello"))
	}
	z.Close()
	p := filepath.Join(t.TempDir(), "test.zip")
	os.WriteFile(p, b.Bytes(), 0600)
	return p
}
func TestUnpack(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		ok    bool
	}{{"valid", []string{"index.html", "assets/app.js"}, true}, {"nested dist", []string{"dist/index.html"}, true}, {"traversal", []string{"index.html", "../escape"}, false}, {"absolute", []string{"index.html", "/escape"}, false}, {"windows", []string{"index.html", "C:/escape"}, false}, {"backslash", []string{"index.html", "a\\escape"}, false}, {"duplicate", []string{"index.html", "index.html"}, false}, {"dot env", []string{"index.html", ".env"}, false}, {"conflicting files", []string{"index.html", "assets", "assets/x"}, false}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := unpack(makeArchive(t, tt.files), t.TempDir())
			if (e == nil) != tt.ok {
				t.Fatalf("unpack=%v want success %v", e, tt.ok)
			}
		})
	}
}
func TestSymlinkRejected(t *testing.T) {
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	h := &zip.FileHeader{Name: "index.html"}
	h.SetMode(os.ModeSymlink | 0777)
	f, _ := z.CreateHeader(h)
	f.Write([]byte("/etc/passwd"))
	z.Close()
	p := filepath.Join(t.TempDir(), "a.zip")
	os.WriteFile(p, b.Bytes(), 0600)
	if unpack(p, t.TempDir()) == nil {
		t.Fatal("accepted symbolic link")
	}
}
func TestPassword(t *testing.T) {
	h := hashPassword("correct horse battery")
	if !checkPassword("correct horse battery", h) || checkPassword("wrong", h) {
		t.Fatal("password verification")
	}
}
func TestLoginLimiter(t *testing.T) {
	key := "unit-test"
	loginMu.Lock()
	delete(loginWindows, key)
	loginMu.Unlock()
	for n := 0; n < 20; n++ {
		if !allowLogin(key) {
			t.Fatal("early rate limit")
		}
	}
	if allowLogin(key) {
		t.Fatal("missing rate limit")
	}
}
func TestDiskCapacity(t *testing.T) {
	free, total, e := diskSpace(t.TempDir())
	if e != nil || total == 0 || free > total {
		t.Fatalf("disk stats: %d %d %v", free, total, e)
	}
}
func TestWrapperNormalization(t *testing.T) {
	for _, tt := range []struct {
		name  string
		files []string
		ok    bool
	}{{"arbitrary wrapper", []string{"prototype/index.html", "prototype/assets/app.js"}, true}, {"nested wrappers", []string{"export/dist/index.html", "export/dist/assets/app.js"}, true}, {"ambiguous", []string{"one/index.html", "two/index.html"}, false}, {"extra root file", []string{"readme.txt", "dist/index.html"}, false}, {"root wins", []string{"index.html", "dist/index.html"}, true}, {"mac metadata", []string{".DS_Store", "__MACOSX/._dist", "dist/._index.html", "dist/index.html", "dist/assets/app.js"}, true}, {"hidden env", []string{"dist/index.html", "dist/.env"}, false}, {"metadata traversal", []string{"dist/index.html", "__MACOSX/../escape"}, false}} {
		t.Run(tt.name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "stage")
			os.Mkdir(dest, 0700)
			e := unpack(makeArchive(t, tt.files), dest)
			if (e == nil) != tt.ok {
				t.Fatalf("unpack: %v", e)
			}
			if tt.ok {
				if _, e = os.Stat(filepath.Join(dest, "index.html")); e != nil {
					t.Fatal("root index missing", e)
				}
				if _, e = os.Stat(filepath.Join(dest, ".DS_Store")); !os.IsNotExist(e) {
					t.Fatal("metadata persisted")
				}
			}
		})
	}
}
func TestNormalizedNewDirectoryKeepsOldRelease(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "old")
	next := filepath.Join(root, "next")
	os.Mkdir(old, 0700)
	os.Mkdir(next, 0700)
	os.WriteFile(filepath.Join(old, "old.js"), []byte("old"), 0600)
	if e := unpack(makeArchive(t, []string{"dist/index.html", "dist/assets/new.js"}), next); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(next, "old.js")); !os.IsNotExist(e) {
		t.Fatal("old file in new release")
	}
	if b, e := os.ReadFile(filepath.Join(old, "old.js")); e != nil || string(b) != "old" {
		t.Fatal("old release changed")
	}
}
