package main

import (
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
)

type projectCollection struct {
	Items        []map[string]any `json:"items"`
	SortMode     string           `json:"sortMode"`
	SortRevision int64            `json:"sortRevision"`
}

// Order is a viewer preference, never a modification of another owner's project.
// Anonymous collections read only their owner's preference, filtering drafts out.
func (a *app) saveProjectOrder(w http.ResponseWriter, r *http.Request, i identity) error {
	var in struct {
		Mode             string   `json:"mode"`
		ProjectIDs       []string `json:"projectIds"`
		ExpectedRevision *int64   `json:"expectedRevision"`
	}
	if e := body(r, &in); e != nil {
		return e
	}
	if (in.Mode != "updated" && in.Mode != "manual") || in.ExpectedRevision == nil || *in.ExpectedRevision < 0 || len(in.ProjectIDs) > 10000 {
		return apiError{422, "INVALID_ORDER", "排序信息无效，请刷新后重试"}
	}
	seen := map[string]bool{}
	for _, id := range in.ProjectIDs {
		if len(id) != 48 || seen[id] {
			return apiError{422, "INVALID_ORDER", "排序中存在无效或重复项目"}
		}
		seen[id] = true
	}
	ctx := r.Context()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Serialize this account's order writes, including the first preference row.
	var userID string
	if e = tx.QueryRow(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", i.ID).Scan(&userID); e != nil {
		return e
	}
	var revision int64
	e = tx.QueryRow(ctx, "SELECT revision FROM project_list_preferences WHERE user_id=$1", i.ID).Scan(&revision)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if revision != *in.ExpectedRevision {
		return apiError{409, "ORDER_CHANGED", "排序已在其他窗口更新，请刷新后再调整"}
	}
	if in.Mode == "manual" {
		rows, err := tx.Query(ctx, "SELECT id FROM projects WHERE ($1='admin' OR owner_id=$2) ORDER BY id FOR SHARE", i.Role, i.ID)
		if err != nil {
			return err
		}
		visible := map[string]bool{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			visible[id] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for id := range seen {
			if !visible[id] {
				return apiError{403, "FORBIDDEN", "不能调整无权查看的项目"}
			}
		}
		if len(visible) != len(seen) {
			return apiError{409, "PROJECT_LIST_CHANGED", "项目列表已有变化，请刷新后重新调整"}
		}
	}
	if _, e = tx.Exec(ctx, "DELETE FROM project_list_order WHERE user_id=$1", i.ID); e != nil {
		return e
	}
	if in.Mode == "manual" && len(in.ProjectIDs) > 0 {
		if _, e = tx.Exec(ctx, "INSERT INTO project_list_order(user_id,project_id,position) SELECT $1,x.id,x.position FROM unnest($2::text[]) WITH ORDINALITY AS x(id,position)", i.ID, in.ProjectIDs); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "INSERT INTO project_list_preferences(user_id,mode,revision) VALUES($1,$2,1) ON CONFLICT(user_id) DO UPDATE SET mode=EXCLUDED.mode,revision=project_list_preferences.revision+1", i.ID, in.Mode); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	result, e := a.projectCollection(r, i, "")
	if e != nil {
		return e
	}
	write(w, result)
	return nil
}
