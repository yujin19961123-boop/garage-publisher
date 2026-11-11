package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type memberUsage struct {
	user
	StorageBytes    *int64     `json:"storageBytes"`
	LoginCount      int64      `json:"loginCount"`
	LastLoginAt     *time.Time `json:"lastLoginAt"`
	LoginStatsSince time.Time  `json:"loginStatsSince"`
}

func (a *app) memberUsage(ctx context.Context) ([]memberUsage, *time.Time, error) {
	// Consistent ownership snapshot, including deleted projects still awaiting
	// cleanup. Do not hold database locks while traversing the filesystem.
	tx, e := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, nil, e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, "SELECT id,username,role,status,login_count,last_login_at,login_stats_since FROM users ORDER BY created_at,id")
	if e != nil {
		return nil, nil, e
	}
	items := []memberUsage{}
	for rows.Next() {
		var item memberUsage
		if e = rows.Scan(&item.ID, &item.Username, &item.Role, &item.Status, &item.LoginCount, &item.LastLoginAt, &item.LoginStatsSince); e != nil {
			rows.Close()
			return nil, nil, e
		}
		items = append(items, item)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, nil, e
	}
	owners := []map[string]string{{}, {}}
	queries := []string{
		"SELECT id,owner_id FROM projects UNION ALL SELECT project_id,owner_id FROM project_cleanup_jobs WHERE owner_id IS NOT NULL",
		"SELECT d.id,p.owner_id FROM deployments d JOIN projects p ON p.id=d.project_id UNION ALL SELECT unnest(deployment_ids),owner_id FROM project_cleanup_jobs WHERE owner_id IS NOT NULL",
	}
	for index, query := range queries {
		rows, e = tx.Query(ctx, query)
		if e != nil {
			return nil, nil, e
		}
		for rows.Next() {
			var id, owner string
			if e = rows.Scan(&id, &owner); e != nil {
				rows.Close()
				return nil, nil, e
			}
			owners[index][id] = owner
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, nil, e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, nil, e
	}
	scanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	usage, e := scanMemberStorage(scanCtx, a.data, owners[0], owners[1])
	if e != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		log.Printf("member storage measurement unavailable: %v", e)
		// Never present incomplete or unreadable storage as a plausible zero.
		return items, nil, nil
	}
	for index := range items {
		value := usage[items[index].ID]
		items[index].StorageBytes = &value
	}
	measuredAt := time.Now()
	return items, &measuredAt, nil
}

// File-byte totals, not ZIP sizes or historical upload sums. Includes manifests,
// retained/expired releases still on disk, staging, archives and failed leftovers.
// Shared DB/logs/images/backups and filesystem block overhead are not attributed.
func scanMemberStorage(ctx context.Context, data string, projects, deployments map[string]string) (map[string]int64, error) {
	totals := map[string]int64{}
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
			return nil, fmt.Errorf("storage ancestor is a symbolic link")
		}
		if err == nil && !info.IsDir() {
			return nil, fmt.Errorf("storage ancestor is not a directory")
		}
		if filepath.Dir(ancestor) == ancestor {
			break
		}
	}
	for _, folder := range []string{"releases", "uploads", "staging"} {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		dir := filepath.Join(root, folder)
		info, err := os.Lstat(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, fmt.Errorf("invalid storage directory")
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			id := entry.Name()
			owner := ""
			switch folder {
			case "releases":
				owner = projects[id]
			case "uploads":
				if strings.HasSuffix(id, ".zip.part") {
					id = strings.TrimSuffix(id, ".zip.part")
				} else if strings.HasSuffix(id, ".zip") {
					id = strings.TrimSuffix(id, ".zip")
				} else {
					continue
				}
				owner = deployments[id]
			case "staging":
				owner = deployments[strings.TrimSuffix(id, ".normalized")]
			}
			if owner == "" {
				continue
			}
			err = filepath.WalkDir(filepath.Join(dir, entry.Name()), func(path string, d fs.DirEntry, walkErr error) error {
				if e := ctx.Err(); e != nil {
					return e
				}
				if os.IsNotExist(walkErr) {
					return nil
				} // Concurrent cleanup/rename.
				if walkErr != nil {
					return walkErr
				}
				if d.Type()&os.ModeSymlink != 0 {
					return fmt.Errorf("storage contains a symbolic link")
				}
				if d.IsDir() {
					return nil
				}
				info, e := d.Info()
				if os.IsNotExist(e) {
					return nil
				}
				if e != nil {
					return e
				}
				if !info.Mode().IsRegular() {
					return fmt.Errorf("storage contains a special file")
				}
				if info.Size() < 0 || totals[owner] > math.MaxInt64-info.Size() {
					return fmt.Errorf("storage size overflow")
				}
				totals[owner] += info.Size()
				return nil
			})
			if err != nil {
				return nil, err
			}
		}
	}
	return totals, nil
}
