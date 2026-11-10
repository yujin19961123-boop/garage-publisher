package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func (a *app) deleteProject(w http.ResponseWriter, r *http.Request, i identity, id string) error {
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(92387414)"); e != nil {
		return e
	}
	var owner, slug string
	e = tx.QueryRow(ctx, "SELECT owner_id,public_id FROM projects WHERE id=$1 FOR UPDATE", id).Scan(&owner, &slug)
	if errors.Is(e, pgx.ErrNoRows) {
		return apiError{404, "NOT_FOUND", "项目不存在"}
	}
	if e != nil {
		return e
	}
	if owner != i.ID {
		return apiError{403, "FORBIDDEN", "只能删除自己的项目"}
	}
	var busy bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deployments WHERE project_id=$1 AND status IN ('UPLOADING','QUEUED','VALIDATING','PREPARING'))", id).Scan(&busy); e != nil {
		return e
	}
	if busy {
		return apiError{409, "DEPLOYMENT_BUSY", "这个项目正在发布，请完成后再删除"}
	}
	rows, e := tx.Query(ctx, "SELECT id FROM deployments WHERE project_id=$1", id)
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var did string
		if e = rows.Scan(&did); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, did)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO deleted_project_slugs(public_id) VALUES($1) ON CONFLICT DO NOTHING", []any{slug}},
		{"INSERT INTO project_cleanup_jobs(project_id,deployment_ids) VALUES($1,$2)", []any{id, ids}},
		{"DELETE FROM releases WHERE project_id=$1", []any{id}},
		{"DELETE FROM deployments WHERE project_id=$1", []any{id}},
		{"DELETE FROM projects WHERE id=$1", []any{id}},
		{"INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,'delete_project',$2)", []any{i.ID, id}},
	} {
		if _, e = tx.Exec(ctx, query.sql, query.args...); e != nil {
			return e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	go func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		a.cleanupJobs(cleanupCtx, a.db)
	}()
	write(w, map[string]bool{"ok": true})
	return nil
}

var generatedID = regexp.MustCompile(`^[0-9a-f]{48}$`)

func cleanupTargets(data, id string, deployments []string) ([]string, error) {
	if !generatedID.MatchString(id) {
		return nil, fmt.Errorf("invalid project cleanup identifier")
	}
	root, e := filepath.Abs(data)
	if e != nil {
		return nil, e
	}
	for ancestor := root; ; ancestor = filepath.Dir(ancestor) {
		info, err := os.Lstat(ancestor)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("data directory ancestor contains symbolic link")
		}
		if filepath.Dir(ancestor) == ancestor {
			break
		}
	}
	targets := []string{filepath.Join(root, "releases", id)}
	for _, did := range deployments {
		if !generatedID.MatchString(did) {
			return nil, fmt.Errorf("invalid deployment cleanup identifier")
		}
		targets = append(targets, filepath.Join(root, "uploads", did+".zip"), filepath.Join(root, "uploads", did+".zip.part"), filepath.Join(root, "staging", did), filepath.Join(root, "staging", did+".normalized"))
	}
	for _, target := range targets {
		rel, e := filepath.Rel(root, target)
		if e != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
			return nil, fmt.Errorf("unsafe cleanup path")
		}
		// Reject symbolic/reparse links in every ancestor and descendant before deleting anything.
		for check := target; ; check = filepath.Dir(check) {
			info, e := os.Lstat(check)
			if e != nil && !os.IsNotExist(e) {
				return nil, e
			}
			if e == nil && info.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("cleanup path contains symbolic link")
			}
			if check == root {
				break
			}
			if filepath.Dir(check) == check {
				return nil, fmt.Errorf("cleanup escaped data directory")
			}
		}
		if e = filepath.WalkDir(target, func(p string, d os.DirEntry, err error) error {
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil {
				return err
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("cleanup target contains symbolic link")
			}
			return nil
		}); e != nil {
			return nil, e
		}
	}
	return targets, nil
}
func cleanupProjectFiles(data, id string, deployments []string) error {
	targets, e := cleanupTargets(data, id, deployments)
	if e != nil {
		return e
	}
	for _, p := range targets {
		if e = os.RemoveAll(p); e != nil {
			return e
		}
	}
	return nil
}

type cleanupDB interface {
	Begin(context.Context) (pgx.Tx, error)
}

func (a *app) cleanupJobs(ctx context.Context, db cleanupDB) {
	// One bounded batch, retried by the worker. SKIP LOCKED permits an HTTP cleanup attempt too.
	tx, e := db.Begin(ctx)
	if e != nil {
		return
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, "SELECT project_id,deployment_ids FROM project_cleanup_jobs ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED")
	if e != nil {
		return
	}
	type job struct {
		id  string
		ids []string
	}
	jobs := []job{}
	for rows.Next() {
		var j job
		if e = rows.Scan(&j.id, &j.ids); e != nil {
			rows.Close()
			return
		}
		jobs = append(jobs, j)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return
	}
	for _, j := range jobs {
		if e = cleanupProjectFiles(a.data, j.id, j.ids); e != nil {
			log.Printf("project cleanup %s: %v", j.id, e)
			_, e = tx.Exec(ctx, "UPDATE project_cleanup_jobs SET attempts=attempts+1,last_error='文件清理失败，将自动重试' WHERE project_id=$1", j.id)
		} else {
			_, e = tx.Exec(ctx, "DELETE FROM project_cleanup_jobs WHERE project_id=$1", j.id)
		}
		if e != nil {
			return
		}
	}
	if e = tx.Commit(ctx); e != nil {
		log.Printf("cleanup transaction: %v", e)
	}
}
