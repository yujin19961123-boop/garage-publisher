package main

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// Reserve enough headroom for all in-flight archives and expanded results.
type capacityQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (a *app) checkCapacity(ctx context.Context, queries ...capacityQuerier) error {
	free, total, e := diskSpace(a.data)
	if e != nil {
		return apiError{503, "STORAGE_UNAVAILABLE", "暂时无法发布，请联系管理员"}
	}
	var active uint64
	var q capacityQuerier = a.db
	if len(queries) > 0 {
		q = queries[0]
	}
	if e = q.QueryRow(ctx, "SELECT count(*) FROM deployments WHERE status IN ('UPLOADING','QUEUED','VALIDATING','PREPARING')").Scan(&active); e != nil {
		return e
	}
	reserve := uint64(1<<30) + (active+1)*uint64(maxUpload+maxExpanded)
	if free < reserve || free < total/10 {
		return apiError{503, "STORAGE_FULL", "平台空间不足，请联系管理员；之前发布的内容仍可打开"}
	}
	return nil
}
