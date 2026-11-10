package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Optional boundary check for ZIP files produced by the real browser packer.
// It never connects to the database or creates platform projects.
func TestBrowserUploadArchives(t *testing.T) {
	fixtures := os.Getenv("BROWSER_UPLOAD_FIXTURES")
	if fixtures == "" {
		t.Skip("set BROWSER_UPLOAD_FIXTURES to browser-generated ZIP paths")
	}
	for _, archive := range filepath.SplitList(fixtures) {
		t.Run(filepath.Base(archive), func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "stage")
			if err := os.Mkdir(dest, 0700); err != nil {
				t.Fatal(err)
			}
			if err := unpack(archive, dest); err != nil {
				t.Fatal(err)
			}
			entry, err := os.ReadFile(filepath.Join(dest, "index.html"))
			if err != nil || !strings.Contains(string(entry), "browser-folder-test") {
				t.Fatalf("entry mismatch: %s, %v", entry, err)
			}
			asset, err := os.ReadFile(filepath.Join(dest, "assets", "app.js"))
			if err != nil || string(asset) != "nested-asset" {
				t.Fatalf("asset mismatch: %s, %v", asset, err)
			}
		})
	}
}

func TestOriginalArchivePathAdaptation(t *testing.T) {
	archive := os.Getenv("ORIGINAL_DIST_ZIP")
	if archive == "" {
		t.Skip("set ORIGINAL_DIST_ZIP for real artifact compatibility")
	}
	dest := filepath.Join(t.TempDir(), "stage")
	if err := os.Mkdir(dest, 0700); err != nil {
		t.Fatal(err)
	}
	if err := unpack(archive, dest); err != nil {
		t.Fatal(err)
	}
	if err := adaptPathResources(dest, "/compatibility-test/"); err != nil {
		t.Fatal(err)
	}
	entry, err := os.ReadFile(filepath.Join(dest, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(entry), "/compatibility-test/assets/") {
		t.Fatal("root assets not adapted")
	}
	if err := adaptPathResources(dest, "/compatibility-test/"); err != nil {
		t.Fatal("second pass:", err)
	}
}
