package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const retainedVersions = 5
const activeDeploymentSQL = "SELECT EXISTS(SELECT 1 FROM deployments WHERE project_id=$1 AND status IN ('UPLOADING','QUEUED','VALIDATING','PREPARING'))"

// All writes to publication state and file collection take the project row lock.
func lockVersionProject(ctx context.Context, tx pgx.Tx, pid, uid string) (*string, error) {
	var owner string
	var current *string
	err := tx.QueryRow(ctx, "SELECT owner_id,current_release_id FROM projects WHERE id=$1 FOR UPDATE", pid).Scan(&owner, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiError{404, "NOT_FOUND", "项目不存在"}
	}
	if err != nil {
		return nil, err
	}
	if owner != uid {
		return nil, apiError{403, "FORBIDDEN", "只能管理自己的版本记录"}
	}
	return current, nil
}

func (a *app) versionList(w http.ResponseWriter, r *http.Request, i identity, pid string) error {
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	current, e := lockVersionProject(r.Context(), tx, pid, i.ID)
	if e != nil {
		return e
	}
	var busy, pending bool
	if e = tx.QueryRow(r.Context(), activeDeploymentSQL, pid).Scan(&busy); e != nil {
		return e
	}
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM version_cleanup_jobs WHERE project_id=$1)", pid).Scan(&pending); e != nil {
		return e
	}
	rows, e := tx.Query(r.Context(), "SELECT id,version_number,created_at FROM releases WHERE project_id=$1 AND expired_at IS NULL ORDER BY version_number DESC", pid)
	if e != nil {
		return e
	}
	items := []map[string]any{}
	for rows.Next() {
		var id string
		var number int
		var created time.Time
		if e = rows.Scan(&id, &number, &created); e != nil {
			rows.Close()
			return e
		}
		isCurrent := current != nil && *current == id
		available := versionFilesAvailable(a.data, pid, id)
		state := "available"
		if !available {
			state = "missing"
		}
		items = append(items, map[string]any{"id": id, "versionNumber": number, "createdAt": created, "isCurrent": isCurrent, "canActivate": available && !isCurrent && !busy, "filesState": state})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	write(w, map[string]any{"items": items, "currentReleaseId": current, "busy": busy, "cleanupPending": pending, "retentionLimit": retainedVersions})
	return nil
}

type historyCursor struct {
	Created time.Time `json:"created"`
	ID      string    `json:"id"`
}

func (a *app) deploymentHistory(w http.ResponseWriter, r *http.Request, i identity, pid string) error {
	if e := a.owned(r.Context(), pid, i.ID); e != nil {
		return e
	}
	var cursor historyCursor
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		b, e := base64.RawURLEncoding.DecodeString(raw)
		if e != nil || len(raw) > 512 || json.Unmarshal(b, &cursor) != nil || cursor.Created.IsZero() || !generatedID.MatchString(cursor.ID) {
			return apiError{422, "INVALID_CURSOR", "记录页码无效，请刷新后重试"}
		}
	}
	return a.readDeploymentHistory(w, r, pid, cursor)
}

func (a *app) readDeploymentHistory(w http.ResponseWriter, r *http.Request, pid string, cursor historyCursor) error {
	var before *time.Time
	if !cursor.Created.IsZero() {
		before = &cursor.Created
	}
	rows, e := a.db.Query(r.Context(), `SELECT d.id,d.status,d.error_message,d.created_at,d.updated_at,r.id,r.version_number,r.expired_at,r.cleaned_at,p.current_release_id
 FROM deployments d JOIN projects p ON p.id=d.project_id LEFT JOIN releases r ON r.deployment_id=d.id
 WHERE d.project_id=$1 AND ($2::timestamptz IS NULL OR (d.created_at,d.id)<($2::timestamptz,$3::text)) ORDER BY d.created_at DESC,d.id DESC LIMIT 21`, pid, before, cursor.ID)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []map[string]any{}
	var next *string
	var last historyCursor
	for rows.Next() {
		var id, status, msg string
		var created, updated time.Time
		var release, current *string
		var number *int
		var expired, cleaned *time.Time
		if e = rows.Scan(&id, &status, &msg, &created, &updated, &release, &number, &expired, &cleaned, &current); e != nil {
			return e
		}
		if len(items) == 20 {
			b, _ := json.Marshal(last)
			value := base64.RawURLEncoding.EncodeToString(b)
			next = &value
			break
		}
		var state *string
		if release != nil {
			value := "available"
			if expired != nil {
				value = "cleanup_pending"
			}
			if cleaned != nil {
				value = "cleaned"
			}
			if expired == nil && !versionFilesAvailable(a.data, pid, *release) {
				value = "missing"
			}
			state = &value
		}
		items = append(items, map[string]any{"id": id, "status": status, "errorMessage": msg, "createdAt": created, "updatedAt": updated, "releaseId": release, "versionNumber": number, "filesState": state, "isCurrent": release != nil && current != nil && *release == *current})
		last = historyCursor{created, id}
	}
	if e = rows.Err(); e != nil {
		return e
	}
	write(w, map[string]any{"items": items, "nextCursor": next})
	return nil
}

func (a *app) activateVersion(w http.ResponseWriter, r *http.Request, i identity, pid, rid string) error {
	var in struct {
		Expected *string `json:"expectedCurrentReleaseId"`
	}
	if e := body(r, &in); e != nil {
		return e
	}
	if in.Expected == nil || !generatedID.MatchString(*in.Expected) || !generatedID.MatchString(rid) {
		return apiError{422, "INVALID_VERSION", "版本信息无效，请刷新后重试"}
	}
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Same user -> project lock order as the publication worker and account changes.
	var state string
	if e = tx.QueryRow(ctx, "SELECT status FROM users WHERE id=$1 FOR UPDATE", i.ID).Scan(&state); e != nil {
		return e
	}
	if state != "active" {
		return apiError{401, "UNAUTHENTICATED", "账号已停用，请重新登录"}
	}
	current, e := lockVersionProject(ctx, tx, pid, i.ID)
	if e != nil {
		return e
	}
	var busy bool
	if e = tx.QueryRow(ctx, activeDeploymentSQL, pid).Scan(&busy); e != nil {
		return e
	}
	if busy {
		return apiError{409, "DEPLOYMENT_BUSY", "这个项目正在发布，请完成后再切换"}
	}
	var number int
	var expired *time.Time
	e = tx.QueryRow(ctx, "SELECT version_number,expired_at FROM releases WHERE id=$1 AND project_id=$2", rid, pid).Scan(&number, &expired)
	if errors.Is(e, pgx.ErrNoRows) {
		return apiError{404, "VERSION_NOT_FOUND", "版本不存在"}
	}
	if e != nil {
		return e
	}
	if expired != nil {
		return apiError{409, "VERSION_EXPIRED", "该版本已超出保留范围，无法切换"}
	}
	if current == nil || *current != rid {
		if current == nil || *current != *in.Expected {
			return apiError{409, "VERSION_CHANGED", "当前版本已变化，请刷新版本记录后重试"}
		}
		if e = validateVersionFiles(a.data, pid, rid); e != nil {
			return apiError{409, "VERSION_UNAVAILABLE", "版本文件不完整，无法切换；当前版本保持不变"}
		}
		if _, e = tx.Exec(ctx, "UPDATE projects SET current_release_id=$2,last_published_at=now(),updated_at=clock_timestamp() WHERE id=$1", pid, rid); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,'activate_version',$2)", i.ID, rid); e != nil {
			return e
		}
	}
	var published *time.Time
	if e = tx.QueryRow(ctx, "SELECT last_published_at FROM projects WHERE id=$1", pid).Scan(&published); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	write(w, map[string]any{"ok": true, "currentReleaseId": rid, "currentVersionNumber": number, "lastPublishedAt": published})
	return nil
}

func expireVersions(ctx context.Context, tx pgx.Tx, pid string) error {
	_, e := tx.Exec(ctx, `UPDATE releases SET expired_at=now() WHERE project_id=$1 AND expired_at IS NULL AND id IN (
 SELECT r.id FROM releases r JOIN projects p ON p.id=r.project_id WHERE r.project_id=$1 AND r.expired_at IS NULL
 ORDER BY (r.id IS NOT DISTINCT FROM p.current_release_id) DESC,r.version_number DESC OFFSET 5)`, pid)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO version_cleanup_jobs(deployment_id,project_id)
 SELECT deployment_id,project_id FROM releases WHERE project_id=$1 AND expired_at IS NOT NULL AND cleaned_at IS NULL ON CONFLICT DO NOTHING`, pid)
	return e
}

// Startup reconciliation is repeatable. It only collects terminal/expired files;
// publication and activation both serialize through the same project row lock.
func (a *app) reconcileVersions(ctx context.Context, db cleanupDB) error {
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, `SELECT p.id FROM projects p WHERE (SELECT count(*) FROM releases r WHERE r.project_id=p.id AND expired_at IS NULL)>5
 OR EXISTS(SELECT 1 FROM releases r WHERE r.project_id=p.id AND NOT manifest_ready AND expired_at IS NULL) ORDER BY p.id FOR UPDATE`)
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, pid := range ids {
		if e = expireVersions(ctx, tx, pid); e != nil {
			return e
		}
		legacyRows, err := tx.Query(ctx, "SELECT id FROM releases WHERE project_id=$1 AND NOT manifest_ready AND expired_at IS NULL", pid)
		if err != nil {
			return err
		}
		legacy := []string{}
		for legacyRows.Next() {
			var rid string
			if err = legacyRows.Scan(&rid); err != nil {
				break
			}
			legacy = append(legacy, rid)
		}
		if err == nil {
			err = legacyRows.Err()
		}
		legacyRows.Close()
		if err != nil {
			return err
		}
		for _, rid := range legacy {
			root := filepath.Join(a.data, "releases", pid, rid)
			if err = validateVersionFiles(a.data, pid, rid); err != nil {
				if _, statErr := os.Lstat(filepath.Join(root, versionManifestName)); os.IsNotExist(statErr) {
					err = writeVersionManifest(root)
				}
			}
			if err == nil {
				if _, err = tx.Exec(ctx, "UPDATE releases SET manifest_ready=true WHERE id=$1", rid); err != nil {
					return err
				}
			}
		}
	}
	if _, e = tx.Exec(ctx, `INSERT INTO version_cleanup_jobs(deployment_id,project_id)
 SELECT deployment_id,project_id FROM releases WHERE expired_at IS NOT NULL AND cleaned_at IS NULL ON CONFLICT DO NOTHING`); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO version_cleanup_jobs(deployment_id,project_id)
 SELECT d.id,d.project_id FROM deployments d WHERE d.status='FAILED' AND d.files_cleaned_at IS NULL AND NOT EXISTS(SELECT 1 FROM releases r WHERE r.deployment_id=d.id) ON CONFLICT DO NOTHING`)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (a *app) cleanupVersionJobs(ctx context.Context, db cleanupDB) {
	tx, e := db.Begin(ctx)
	if e != nil {
		return
	}
	rows, e := tx.Query(ctx, "SELECT deployment_id,project_id FROM version_cleanup_jobs ORDER BY attempts,created_at LIMIT 20")
	if e != nil {
		tx.Rollback(ctx)
		return
	}
	type job struct{ did, pid string }
	jobs := []job{}
	for rows.Next() {
		var j job
		if e = rows.Scan(&j.did, &j.pid); e != nil {
			break
		}
		jobs = append(jobs, j)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	tx.Rollback(ctx)
	if e != nil {
		return
	}
	for _, j := range jobs {
		if e = a.cleanVersionJob(ctx, db, j.pid, j.did); e != nil {
			log.Printf("version cleanup %s: %v", j.did, e)
		}
	}
}

func (a *app) cleanVersionJob(ctx context.Context, db cleanupDB, pid, did string) error {
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var current *string
	e = tx.QueryRow(ctx, "SELECT current_release_id FROM projects WHERE id=$1 FOR UPDATE", pid).Scan(&current)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	var status string
	var expired *time.Time
	var release *string
	e = tx.QueryRow(ctx, `SELECT d.status,r.expired_at,r.id FROM version_cleanup_jobs j JOIN deployments d ON d.id=j.deployment_id LEFT JOIN releases r ON r.deployment_id=d.id WHERE j.project_id=$1 AND j.deployment_id=$2 FOR UPDATE OF j`, pid, did).Scan(&status, &expired, &release)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	eligible := (status == "FAILED" && release == nil) || (status == "SUCCEEDED" && expired != nil)
	if !eligible || (current != nil && (*current == did || (release != nil && *current == *release))) {
		_, e = tx.Exec(ctx, "UPDATE version_cleanup_jobs SET attempts=attempts+1,last_error='文件仍在使用，未执行清理' WHERE deployment_id=$1", did)
	} else {
		var targets []string
		targets, e = versionCleanupTargets(a.data, pid, did)
		if e == nil && release != nil && *release != did {
			if !generatedID.MatchString(*release) {
				e = fmt.Errorf("invalid release identifier")
			} else {
				targets[0] = filepath.Join(a.data, "releases", pid, *release)
				e = validateManagedPath(a.data, targets[0])
			}
		}
		if e == nil {
			for _, target := range targets {
				if e = os.RemoveAll(target); e != nil {
					break
				}
			}
		}
		if e != nil {
			log.Printf("version cleanup files %s: %v", did, e)
			_, e = tx.Exec(ctx, "UPDATE version_cleanup_jobs SET attempts=attempts+1,last_error='文件清理失败，将自动重试' WHERE deployment_id=$1", did)
		} else {
			if _, e = tx.Exec(ctx, "UPDATE releases SET cleaned_at=now() WHERE deployment_id=$1", did); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, "UPDATE deployments SET files_cleaned_at=now() WHERE id=$1", did); e != nil {
				return e
			}
			_, e = tx.Exec(ctx, "DELETE FROM version_cleanup_jobs WHERE deployment_id=$1", did)
		}
	}
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func versionCleanupTargets(data, pid, did string) ([]string, error) {
	if !generatedID.MatchString(pid) || !generatedID.MatchString(did) {
		return nil, fmt.Errorf("invalid version cleanup identifier")
	}
	targets := []string{filepath.Join(data, "releases", pid, did), filepath.Join(data, "uploads", did+".zip"), filepath.Join(data, "uploads", did+".zip.part"), filepath.Join(data, "staging", did), filepath.Join(data, "staging", did+".normalized")}
	for _, target := range targets {
		if e := validateManagedPath(data, target); e != nil {
			return nil, e
		}
	}
	return targets, nil
}

func validateManagedPath(data, target string) error {
	root, e := filepath.Abs(data)
	if e != nil {
		return e
	}
	target, e = filepath.Abs(target)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(root, target)
	if e != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("unsafe managed path")
	}
	for check := target; ; check = filepath.Dir(check) {
		info, err := os.Lstat(check)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed path contains symbolic link")
		}
		if filepath.Dir(check) == check {
			break
		}
	}
	return filepath.WalkDir(target, func(_ string, d os.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed files contain symbolic link")
		}
		return nil
	})
}
