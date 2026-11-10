package main

import (
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"net/http"
	"strings"
	"time"
)

func (a *app) projectList(r *http.Request, i identity, id string) ([]map[string]any, error) {
	rows, e := a.db.Query(r.Context(), `SELECT p.id,p.public_id,p.owner_id,p.name,p.current_release_id,p.last_published_at,r.version_number FROM projects p LEFT JOIN releases r ON r.id=p.current_release_id WHERE ($1='admin' OR p.owner_id=$2) AND ($3='' OR p.id=$3) ORDER BY p.created_at DESC`, i.Role, i.ID, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var pid, pub, owner, n string
		var release *string
		var published *time.Time
		var number *int
		if e = rows.Scan(&pid, &pub, &owner, &n, &release, &published, &number); e != nil {
			return nil, e
		}
		status := "unpublished"
		if release != nil {
			status = "published"
		}
		items = append(items, map[string]any{"id": pid, "publicId": pub, "ownerId": owner, "name": n, "status": status, "url": a.url(pub), "lastPublishedAt": published, "currentReleaseId": release, "currentVersionNumber": number})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	rows.Close()
	for _, p := range items {
		var did, ds, de string
		err := a.db.QueryRow(r.Context(), "SELECT id,status,error_message FROM deployments WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", p["id"]).Scan(&did, &ds, &de)
		if err == nil {
			p["latestDeployment"] = map[string]any{"id": did, "status": ds, "errorMessage": de}
		}
	}
	return items, nil
}
func (a *app) projects(w http.ResponseWriter, r *http.Request, i identity, p []string) error {
	ctx := r.Context()
	if len(p) == 1 && r.Method == "GET" {
		v, e := a.projectList(r, i, "")
		if e != nil {
			return e
		}
		write(w, map[string]any{"items": v})
		return nil
	}
	if len(p) == 1 && r.Method == "POST" {
		var in struct{ Name string }
		if e := body(r, &in); e != nil {
			return e
		}
		in.Name = strings.TrimSpace(in.Name)
		if len(in.Name) == 0 || len(in.Name) > 200 {
			return apiError{422, "INVALID_INPUT", "请填写项目名称；如果名称太长，请缩短后重试"}
		}
		id := token()
		e := a.createProject(ctx, id, i.ID, in.Name)
		if e != nil {
			return e
		}
		v, e := a.projectList(r, i, id)
		if e != nil {
			return e
		}
		if len(v) == 0 {
			return apiError{404, "NOT_FOUND", "项目不存在"}
		}
		write(w, v[0])
		return nil
	}
	if len(p) < 2 {
		return apiError{405, "METHOD_NOT_ALLOWED", "不支持的操作"}
	}
	if len(p) == 2 && r.Method == "GET" {
		v, e := a.projectList(r, i, p[1])
		if e != nil {
			return e
		}
		if len(v) == 0 {
			return apiError{404, "NOT_FOUND", "项目不存在"}
		}
		if len(v) == 0 {
			return apiError{404, "NOT_FOUND", "项目不存在"}
		}
		write(w, v[0])
		return nil
	}
	if e := a.owned(ctx, p[1], i.ID); e != nil {
		return e
	}
	if len(p) == 3 && p[2] == "versions" && r.Method == "GET" {
		return a.versionList(w, r, i, p[1])
	}
	if len(p) == 3 && p[2] == "deployments" && r.Method == "GET" {
		return a.deploymentHistory(w, r, i, p[1])
	}
	if len(p) == 5 && p[2] == "versions" && p[4] == "activate" && r.Method == "POST" {
		return a.activateVersion(w, r, i, p[1], p[3])
	}
	if len(p) == 2 && r.Method == "DELETE" {
		return a.deleteProject(w, r, i, p[1])
	}
	if len(p) == 2 && r.Method == "PATCH" {
		var in struct{ Name string }
		if e := body(r, &in); e != nil {
			return e
		}
		in.Name = strings.TrimSpace(in.Name)
		if len(in.Name) == 0 || len(in.Name) > 200 {
			return apiError{422, "INVALID_INPUT", "名称太长，请缩短后重试"}
		}
		_, e := a.db.Exec(ctx, "UPDATE projects SET name=$1 WHERE id=$2", in.Name, p[1])
		if e != nil {
			return e
		}
		v, e := a.projectList(r, i, p[1])
		if e != nil {
			return e
		}
		if len(v) == 0 {
			return apiError{404, "NOT_FOUND", "项目不存在"}
		}
		write(w, v[0])
		return nil
	}
	if len(p) == 3 && p[2] == "deployments" && r.Method == "POST" {
		var in struct {
			RouteMode string `json:"routeMode"`
		}
		if e := body(r, &in); e != nil {
			return e
		}
		if in.RouteMode == "" {
			in.RouteMode = "spa"
		}
		if in.RouteMode != "static" && in.RouteMode != "spa" {
			return apiError{422, "INVALID_ROUTE_MODE", "不支持的路由模式"}
		}
		id := token()
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(92387413)"); e != nil {
			return e
		}
		if e = a.checkCapacity(ctx, tx); e != nil {
			return e
		}
		var owner string
		if e = tx.QueryRow(ctx, "SELECT owner_id FROM projects WHERE id=$1 FOR UPDATE", p[1]).Scan(&owner); errors.Is(e, pgx.ErrNoRows) {
			return apiError{404, "NOT_FOUND", "项目不存在"}
		} else if e != nil {
			return e
		}
		if owner != i.ID {
			return apiError{403, "FORBIDDEN", "无权操作此项目"}
		}
		var cleanupPending bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM version_cleanup_jobs WHERE project_id=$1)", p[1]).Scan(&cleanupPending); e != nil {
			return e
		}
		if cleanupPending {
			return apiError{409, "CLEANUP_PENDING", "旧文件正在清理，请稍后再上传；已有版本仍可查看和切换"}
		}
		_, e = tx.Exec(ctx, "INSERT INTO deployments(id,project_id,operator_id,status,route_mode) VALUES($1,$2,$3,'UPLOADING',$4)", id, p[1], i.ID, in.RouteMode)
		if e != nil {
			var pe *pgconn.PgError
			if errors.As(e, &pe) && pe.Code == "23505" {
				return apiError{409, "DEPLOYMENT_BUSY", "这个项目正在发布，请完成后再试"}
			}
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		write(w, map[string]any{"id": id, "status": "UPLOADING"})
		return nil
	}
	return apiError{404, "NOT_FOUND", "接口不存在"}
}
func (a *app) users(w http.ResponseWriter, r *http.Request, i identity, p []string) error {
	ctx := r.Context()
	if len(p) == 2 && r.Method == "GET" {
		rows, e := a.db.Query(ctx, "SELECT id,username,role,status FROM users ORDER BY created_at")
		if e != nil {
			return e
		}
		defer rows.Close()
		v := []user{}
		for rows.Next() {
			var u user
			if e = rows.Scan(&u.ID, &u.Username, &u.Role, &u.Status); e != nil {
				return e
			}
			v = append(v, u)
		}
		write(w, map[string]any{"items": v})
		return rows.Err()
	}
	if len(p) == 2 && r.Method == "POST" {
		var in struct{ Username, Password string }
		if e := body(r, &in); e != nil {
			return e
		}
		in.Username = strings.TrimSpace(in.Username)
		if len(in.Username) < 2 || len(in.Username) > 64 || len(in.Password) < 6 || len(in.Password) > 256 {
			return apiError{422, "INVALID_INPUT", "请检查账号长度，密码至少6位，允许纯数字"}
		}
		id := token()
		_, e := a.db.Exec(ctx, "INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)", id, in.Username, hashPassword(in.Password))
		if e != nil {
			var pe *pgconn.PgError
			if errors.As(e, &pe) && pe.Code == "23505" {
				return apiError{409, "USERNAME_EXISTS", "账号已存在"}
			}
			return e
		}
		a.db.Exec(ctx, "INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,'create_user',$2)", i.ID, id)
		write(w, user{id, in.Username, "member", "active"})
		return nil
	}
	if len(p) == 4 && ((p[3] == "status" && r.Method == "PATCH") || (p[3] == "reset-password" && r.Method == "POST")) {
		var in struct{ Status, Password string }
		if e := body(r, &in); e != nil {
			return e
		}
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		var role string
		if e = tx.QueryRow(ctx, "SELECT role FROM users WHERE id=$1 FOR UPDATE", p[2]).Scan(&role); e != nil {
			return apiError{404, "NOT_FOUND", "账号不存在"}
		}
		if role == "admin" {
			return apiError{403, "FORBIDDEN", "此入口仅管理成员账号"}
		}
		action := "disable_user"
		if p[3] == "status" {
			if in.Status != "active" && in.Status != "disabled" {
				return apiError{422, "INVALID_INPUT", "状态无效"}
			}
			_, e = tx.Exec(ctx, "UPDATE users SET status=$1,auth_version=auth_version+1 WHERE id=$2", in.Status, p[2])
			action = "set_user_status"
		} else {
			if len(in.Password) < 6 || len(in.Password) > 256 {
				return apiError{422, "INVALID_INPUT", "密码至少6位，请勿超过256个英文字母或数字"}
			}
			_, e = tx.Exec(ctx, "UPDATE users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2", hashPassword(in.Password), p[2])
			action = "reset_password"
		}
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", p[2]); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,$2,$3)", i.ID, action, p[2]); e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		write(w, map[string]bool{"ok": true})
		return nil
	}
	return apiError{404, "NOT_FOUND", "接口不存在"}
}
