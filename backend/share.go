package main

import (
	"bytes"
	"errors"
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
	if e := a.db.QueryRow(ctx, "SELECT count(*) FROM projects WHERE owner_id=$1 AND current_release_id IS NOT NULL", i.ID).Scan(&count); e != nil {
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

var shareTemplate = template.Must(template.New("share").Parse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>原型合集</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#1e293b;font:16px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:auto;padding:56px 24px}header{margin-bottom:32px}h1{font-size:34px;letter-spacing:-1px;margin:0 0 8px}.muted{color:#64748b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:20px}article{padding:26px;background:white;border:1px solid #e2e8f0;border-radius:16px;display:flex;flex-direction:column}h2{font-size:21px;overflow-wrap:anywhere;margin:0 0 12px}.date{font-size:13px;margin-top:20px}a{display:inline-block;color:#4338ca;text-decoration:none;font-weight:650;margin-top:18px}a:hover{text-decoration:underline}.empty{padding:60px 24px;text-align:center;background:white;border-radius:16px;border:1px solid #e2e8f0}footer{margin-top:36px;font-size:13px;color:#64748b}</style></head><body><main><header><h1>原型合集</h1><div class="muted">共 {{.Count}} 个已发布原型</div></header>{{if .Items}}<div class="grid">{{range .Items}}<article><h2>{{.Name}}</h2>{{if .Published}}<div class="date muted">最近发布：{{.Published}}</div>{{end}}<a href="{{.URL}}" target="_blank" rel="noopener noreferrer">打开原型 ↗</a></article>{{end}}</div>{{else}}<div class="empty muted">暂无已发布原型</div>{{end}}<footer>持有链接即可查看 · 内容随发布自动更新</footer></main></body></html>`))

func (a *app) publicSharePage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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
	rows, e := a.db.Query(r.Context(), "SELECT name,public_id,last_published_at FROM projects WHERE owner_id=$1 AND current_release_id IS NOT NULL ORDER BY last_published_at DESC,id", owner)
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
