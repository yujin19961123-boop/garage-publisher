package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const versionManifestName = ".garage-manifest.json"
const versionManifestTemp = ".garage-manifest.tmp"

type manifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type versionManifest struct {
	Files []manifestFile `json:"files"`
}

func fileDigest(file string) (string, int64, error) {
	f, e := os.Open(file)
	if e != nil {
		return "", 0, e
	}
	defer f.Close()
	hash := sha256.New()
	n, e := io.Copy(hash, io.LimitReader(f, maxFile+1))
	if e != nil {
		return "", 0, e
	}
	if n > maxFile {
		return "", 0, fmt.Errorf("version file exceeds limit")
	}
	return hex.EncodeToString(hash.Sum(nil)), n, nil
}

func writeVersionManifest(root string) error {
	if e := validateManagedPath(filepath.Dir(root), root); e != nil {
		return e
	}
	info, e := os.Stat(filepath.Join(root, "index.html"))
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("version entry is not a regular file")
	}
	manifest := versionManifest{Files: []manifestFile{}}
	e = filepath.WalkDir(root, func(file string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == versionManifestName || rel == versionManifestTemp {
			return nil
		}
		if strings.HasPrefix(rel, ".") {
			return fmt.Errorf("unexpected hidden version file")
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("version contains non-regular file")
		}
		hash, size, err := fileDigest(file)
		if err != nil {
			return err
		}
		manifest.Files = append(manifest.Files, manifestFile{rel, size, hash})
		if len(manifest.Files) > maxFiles {
			return fmt.Errorf("too many version files")
		}
		return nil
	})
	if e != nil {
		return e
	}
	b, e := json.Marshal(manifest)
	if e != nil {
		return e
	}
	// A crash must leave either no manifest or a complete manifest. The reserved
	// temporary file can be safely replaced when bootstrapping a legacy release.
	temporary := filepath.Join(root, versionManifestTemp)
	if e = os.Remove(temporary); e != nil && !os.IsNotExist(e) {
		return e
	}
	f, e := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(temporary)
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e == nil {
		e = renamePreparedPath(context.Background(), temporary, filepath.Join(root, versionManifestName))
	}
	return e
}

func versionFilesAvailable(data, pid, rid string) bool {
	if !generatedID.MatchString(pid) || !generatedID.MatchString(rid) {
		return false
	}
	root := filepath.Join(data, "releases", pid, rid)
	for _, name := range []string{"index.html", versionManifestName} {
		info, e := os.Lstat(filepath.Join(root, name))
		if e != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func validateVersionFiles(data, pid, rid string) error {
	if !generatedID.MatchString(pid) || !generatedID.MatchString(rid) {
		return fmt.Errorf("invalid version identifier")
	}
	root := filepath.Join(data, "releases", pid, rid)
	if e := validateManagedPath(data, root); e != nil {
		return e
	}
	f, e := os.Open(filepath.Join(root, versionManifestName))
	if e != nil {
		return e
	}
	defer f.Close()
	var manifest versionManifest
	if e = json.NewDecoder(io.LimitReader(f, 64<<20)).Decode(&manifest); e != nil {
		return e
	}
	if len(manifest.Files) == 0 || len(manifest.Files) > maxFiles {
		return fmt.Errorf("invalid version manifest")
	}
	seen := map[string]bool{}
	hasEntry := false
	for _, item := range manifest.Files {
		n := item.Path
		if n == "" || n == "." || path.Clean(n) != n || strings.ContainsAny(n, "\\:\x00") || strings.HasPrefix(n, "/") || strings.HasPrefix(n, "../") || seen[n] {
			return fmt.Errorf("invalid manifest path")
		}
		for _, part := range strings.Split(n, "/") {
			if strings.HasPrefix(part, ".") {
				return fmt.Errorf("hidden manifest path")
			}
		}
		seen[n] = true
		if n == "index.html" {
			hasEntry = true
		}
		file := filepath.Join(root, filepath.FromSlash(n))
		info, e := os.Lstat(file)
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() || info.Size() != item.Size {
			return fmt.Errorf("version file changed")
		}
		hash, size, e := fileDigest(file)
		if e != nil {
			return e
		}
		if hash != item.SHA256 || size != item.Size {
			return fmt.Errorf("version checksum mismatch")
		}
	}
	if !hasEntry {
		return fmt.Errorf("version entry missing")
	}
	// A manifest represents the entire immutable release, not just a subset.
	// Otherwise an unrecorded extra script could be served after activation.
	return filepath.WalkDir(root, func(file string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == versionManifestName || rel == versionManifestTemp {
			return nil
		}
		if !seen[rel] {
			return fmt.Errorf("version contains unrecorded file")
		}
		return nil
	})
}
