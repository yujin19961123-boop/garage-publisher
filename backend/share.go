package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"html/template"
	"net/http"
	"strings"
	"time"
)

func (a *app) shareURL(slug string) string {
	port := a.publicPortSuffix()
	return a.scheme + "://" + a.domain + port + "/_share/" + slug + "/"
}

func (a *app) sharePageAPI(w http.ResponseWriter, r *http.Request, i identity) error {
	ctx := r.Context()
	var slug string
	if r.Method == "POST" {
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		var username string
		if e = tx.QueryRow(ctx, "SELECT username FROM users WHERE id=$1 FOR UPDATE", i.ID).Scan(&username); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, "SELECT public_id FROM share_pages WHERE owner_id=$1", i.ID).Scan(&slug)
		if errors.Is(e, pgx.ErrNoRows) {
			for _, candidate := range slugCandidates(projectSlug(username)) {
				result, err := tx.Exec(ctx, "INSERT INTO share_pages(owner_id,public_id) VALUES($1,$2) ON CONFLICT(public_id) DO NOTHING", i.ID, candidate)
				if err != nil {
					return err
				}
				if result.RowsAffected() == 1 {
					slug = candidate
					break
				}
			}
			if slug == "" {
				return apiError{422, "SHARE_ADDRESS_EXHAUSTED", "分享地址暂时无法创建，请联系管理员"}
			}
		} else if e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
	} else {
		e := a.db.QueryRow(ctx, "SELECT public_id FROM share_pages WHERE owner_id=$1", i.ID).Scan(&slug)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
	}
	var count int
	if e := a.db.QueryRow(ctx, "SELECT count(*) FROM projects WHERE owner_id=$1 AND current_release_id IS NOT NULL AND NOT unpublished", i.ID).Scan(&count); e != nil {
		return e
	}
	url := ""
	if slug != "" {
		url = a.shareURL(slug)
	}
	write(w, map[string]any{"url": url, "publishedCount": count})
	return nil
}

type shareItem struct{ Name, URL, Published string }
type shareView struct {
	Items []shareItem
	Count int
}

// Assets are embedded so the anonymous collection has no frontend or external
// resource dependency. Only this exact interaction script is allowed by CSP.
//
//go:embed share.html
var shareHTML string

//go:embed share.css
var shareCSS string

//go:embed share.js
var shareJS string

//go:embed share-play.js
var sharePlayJS string

func shareScript() string { return shareJS + "\n" + sharePlayJS }

var shareTemplate = template.Must(template.New("share").Funcs(template.FuncMap{
	"style":   func() template.CSS { return template.CSS(shareCSS) },
	"script":  func() template.JS { return template.JS(shareScript()) },
	"favicon": func() template.URL { return template.URL(platformFaviconDataURL()) },
	"ordinal": func(n int) string { return fmt.Sprintf("%02d", n+1) },
}).Parse(shareHTML))

func shareCSP() string {
	hash := sha256.Sum256([]byte(shareScript()))
	return "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
}

func (a *app) publicSharePage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", shareCSP())
	w.Header().Set("X-Frame-Options", "DENY")
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "仅支持查看", 405)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/_share/")
	slug := strings.TrimSuffix(rest, "/")
	if !publicPattern.MatchString(slug) {
		http.NotFound(w, r)
		return
	}
	var owner string
	e := a.db.QueryRow(r.Context(), "SELECT owner_id FROM share_pages WHERE public_id=$1", slug).Scan(&owner)
	if errors.Is(e, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if e != nil {
		http.Error(w, "暂时无法访问，请稍后重试", 503)
		return
	}
	if !strings.HasSuffix(rest, "/") {
		http.Redirect(w, r, "/_share/"+slug+"/", 301)
		return
	}
	rows, e := a.db.Query(r.Context(), `SELECT p.name,p.public_id,p.last_published_at FROM projects p LEFT JOIN project_list_preferences pref ON pref.user_id=$1 LEFT JOIN project_list_order o ON o.project_id=p.id AND o.user_id=$1 WHERE p.owner_id=$1 AND p.current_release_id IS NOT NULL AND NOT p.unpublished ORDER BY CASE WHEN pref.mode='manual' THEN o.position END ASC NULLS FIRST,p.updated_at DESC,p.created_at DESC,p.id`, owner)
	if e != nil {
		http.Error(w, "暂时无法访问，请稍后重试", 503)
		return
	}
	defer rows.Close()
	view := shareView{Items: []shareItem{}}
	for rows.Next() {
		var item shareItem
		var pub string
		var published *time.Time
		if e = rows.Scan(&item.Name, &pub, &published); e != nil {
			http.Error(w, "暂时无法访问，请稍后重试", 503)
			return
		}
		item.URL = a.url(pub)
		if published != nil {
			item.Published = published.In(time.FixedZone("UTC+8", 8*3600)).Format("2006-01-02 15:04")
		}
		view.Items = append(view.Items, item)
	}
	if rows.Err() != nil {
		http.Error(w, "暂时无法访问，请稍后重试", 503)
		return
	}
	view.Count = len(view.Items)
	var b bytes.Buffer
	if e = shareTemplate.Execute(&b, view); e != nil {
		http.Error(w, "暂时无法访问，请稍后重试", 503)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method != "HEAD" {
		w.Write(b.Bytes())
	}
}
