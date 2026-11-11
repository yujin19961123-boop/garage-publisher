package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var publicPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var legacyPublicPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (a *app) preview(w http.ResponseWriter, r *http.Request, public string) {
	a.previewWithPrefix(w, r, public, "")
}
func (a *app) pathPreview(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/_share/") {
		a.publicSharePage(w, r)
		return
	}
	if r.URL.Path == "/" {
		port := a.publicPortSuffix()
		http.Redirect(w, r, env("CONSOLE_URL", a.scheme+"://console."+a.domain+port+"/"), http.StatusTemporaryRedirect)
		return
	}
	raw := r.URL.Path
	if strings.ContainsAny(raw, "\\\x00") || path.Clean(raw) != strings.TrimSuffix(raw, "/") {
		http.Error(w, "路径无效", 400)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(raw, "/"), "/", 2)
	slug := parts[0]
	if !publicPattern.MatchString(slug) {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 1 {
		http.Redirect(w, r, "/"+slug+"/", http.StatusMovedPermanently)
		return
	}
	clone := r.Clone(r.Context())
	u := *r.URL
	u.Path = "/" + parts[1]
	u.RawPath = ""
	clone.URL = &u
	a.previewWithPrefix(w, clone, slug, "/"+slug)
}
func (a *app) previewWithPrefix(w http.ResponseWriter, r *http.Request, public, prefix string) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "仅支持静态文件访问", 405)
		return
	}
	if !publicPattern.MatchString(public) {
		http.NotFound(w, r)
		return
	}
	var project string
	var release, mode *string
	e := a.db.QueryRow(r.Context(), "SELECT p.id,p.current_release_id,r.route_mode FROM projects p LEFT JOIN releases r ON r.id=p.current_release_id WHERE p.public_id=$1 AND NOT p.unpublished", public).Scan(&project, &release, &mode)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	if release == nil {
		http.Error(w, "该项目尚未发布", 404)
		return
	}
	raw := r.URL.Path
	if strings.ContainsAny(raw, "\\\x00") || path.Clean(raw) != strings.TrimSuffix(raw, "/") && raw != "/" {
		http.Error(w, "路径无效", 400)
		return
	}
	if raw == "/.garage-favicon.svg" {
		servePlatformFavicon(w, r)
		return
	}
	for _, s := range strings.Split(raw, "/") {
		if strings.HasPrefix(s, ".") {
			http.NotFound(w, r)
			return
		}
	}
	root := filepath.Join(a.data, "releases", project, *release)
	file, info, e := resolveStaticPage(root, raw)
	if os.IsNotExist(e) {
		file, info, e = resolveNextStaticPayload(root, raw)
	}
	if e == nil && info.IsDir() {
		if !strings.HasSuffix(raw, "/") {
			http.Redirect(w, r, prefix+raw+"/", 301)
			return
		}
		file = filepath.Join(file, "index.html")
		info, e = os.Stat(file)
	}
	if os.IsNotExist(e) && mode != nil && *mode == "spa" && path.Ext(raw) == "" && !strings.HasPrefix(raw, "/assets/") && strings.Contains(r.Header.Get("Accept"), "text/html") {
		file = filepath.Join(root, "index.html")
		info, e = os.Stat(file)
	}
	if e != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	f, e := os.Open(file)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	if servePrototypeWithFavicon(w, r, f, info, prefix) {
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// Static exporters may emit /about.html for the browser URL /about. Resolve
// actual exported pages before any optional SPA fallback, without hiding assets.
func resolveStaticPage(root, raw string) (string, os.FileInfo, error) {
	file := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(raw, "/")))
	info, err := os.Stat(file)
	if os.IsNotExist(err) && path.Ext(strings.TrimSuffix(raw, "/")) == "" && raw != "/" {
		page := strings.TrimSuffix(file, string(filepath.Separator)) + ".html"
		if pageInfo, pageErr := os.Stat(page); pageErr == nil && !pageInfo.IsDir() {
			return page, pageInfo, nil
		}
	}
	return file, info, err
}
