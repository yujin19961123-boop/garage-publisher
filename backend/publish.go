package main

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"

	"strings"
	"time"
)

const (
	maxUpload   int64 = 100 << 20
	maxExpanded int64 = 500 << 20
	maxFile     int64 = 100 << 20
	maxFiles          = 10000
)

func unpack(archive, dest string) error {
	z, e := zip.OpenReader(archive)
	if e != nil {
		return fmt.Errorf("压缩包打不开，请重新压缩为 ZIP 后再上传")
	}
	defer z.Close()
	if len(z.File) > maxFiles {
		return fmt.Errorf("文件数量超过 %d", maxFiles)
	}
	seen := map[string]bool{}
	var total int64
	deadline := time.Now().Add(5 * time.Minute)
	for _, f := range z.File {
		n := f.Name
		if n == "" || strings.ContainsAny(n, "\\\x00:") || strings.HasPrefix(n, "/") || path.Clean(n) != strings.TrimSuffix(n, "/") || strings.HasPrefix(n, "../") || strings.Contains(n, "/../") || strings.Count(n, "/") > 20 {
			return fmt.Errorf("压缩包里的文件位置有问题，请重新打包后上传")
		}
		n = strings.TrimSuffix(n, "/")
		if seen[n] {
			return fmt.Errorf("压缩包里有重名文件，请整理后重新打包")
		}
		seen[n] = true
		metadata := false
		for _, s := range strings.Split(n, "/") {
			if s == "__MACOSX" || s == ".DS_Store" || strings.HasPrefix(s, "._") {
				metadata = true
			}
			if strings.HasPrefix(s, ".") && s != ".DS_Store" && !strings.HasPrefix(s, "._") {
				return fmt.Errorf("压缩包里包含隐藏文件，请移除后重新打包")
			}
		}
		if f.Mode()&os.ModeSymlink != 0 || (!f.FileInfo().IsDir() && !f.Mode().IsRegular()) {
			return fmt.Errorf("压缩包里包含无法发布的文件，请只保留原型网页和图片等文件")
		}
		if f.Flags&1 != 0 {
			return fmt.Errorf("压缩包设了密码，请去掉密码后重新上传")
		}
		target := filepath.Join(dest, filepath.FromSlash(n))
		rel, e := filepath.Rel(dest, target)
		if e != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return fmt.Errorf("压缩包里的文件位置有问题，请重新打包后上传")
		}
		if f.FileInfo().IsDir() {
			if metadata {
				continue
			}
			if e = os.MkdirAll(target, 0700); e != nil {
				return e
			}
			continue
		}
		if f.UncompressedSize64 > uint64(maxFile) {
			return fmt.Errorf("压缩包里有文件过大，请缩小文件后重新上传")
		}
		if metadata {
			src, err := f.Open()
			if err != nil {
				return fmt.Errorf("压缩包打不开，请重新打包后上传")
			}
			limit := min(maxFile, maxExpanded-total)
			written, err := io.Copy(io.Discard, io.LimitReader(src, limit+1))
			src.Close()
			total += written
			if err != nil || written > limit {
				return fmt.Errorf("压缩包解开后的文件太大或已损坏，请重新打包后上传")
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("这次处理时间太长，请稍后重新上传")
			}
			continue
		}
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		src, e := f.Open()
		if e != nil {
			return fmt.Errorf("压缩包打不开，请重新打包后上传")
		}
		out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			src.Close()
			return e
		}
		limit := min(maxFile, maxExpanded-total)
		written, ce := io.Copy(out, io.LimitReader(src, limit+1))
		src.Close()
		syncErr := out.Sync()
		closeErr := out.Close()
		total += written
		if ce != nil || syncErr != nil || closeErr != nil {
			return fmt.Errorf("解压失败或存储空间不足")
		}
		if written > limit {
			return fmt.Errorf("压缩包解开后的文件太大，请减少文件后重新上传")
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("这次处理时间太长，请稍后重新上传")
		}
	}
	return normalizeEntry(dest)
}

// Only strip a chain of single enclosing directories; never guess among pages.
func normalizeEntry(dest string) error {
	current := dest
	for depth := 0; depth <= 20; depth++ {
		info, e := os.Stat(filepath.Join(current, "index.html"))
		if e == nil && info.Mode().IsRegular() {
			if current == dest {
				return nil
			}
			temp := dest + ".normalized"
			if _, err := os.Stat(temp); !os.IsNotExist(err) {
				return fmt.Errorf("文件处理失败，请重新上传")
			}
			defer os.RemoveAll(temp)
			if e = os.Rename(current, temp); e != nil {
				return e
			}
			if e = os.RemoveAll(dest); e != nil {
				return e
			}
			return os.Rename(temp, dest)
		}
		entries, e := os.ReadDir(current)
		if e != nil {
			return e
		}
		if len(entries) != 1 || !entries[0].IsDir() {
			break
		}
		current = filepath.Join(current, entries[0].Name())
	}
	return fmt.Errorf("没有找到首页 index.html，请检查上传内容是否包含完整的网页文件")
}
func (a *app) deploymentAPI(w http.ResponseWriter, r *http.Request, i identity, p []string) error {
	if len(p) < 2 {
		return apiError{404, "NOT_FOUND", "任务不存在"}
	}
	ctx := r.Context()
	var project, status, msg string
	e := a.db.QueryRow(ctx, "SELECT project_id,status,error_message FROM deployments WHERE id=$1", p[1]).Scan(&project, &status, &msg)
	if e != nil {
		return apiError{404, "NOT_FOUND", "任务不存在"}
	}
	if e = a.owned(ctx, project, i.ID); e != nil {
		return e
	}
	if len(p) == 2 && r.Method == "GET" {
		write(w, map[string]any{"id": p[1], "status": status, "errorMessage": msg})
		return nil
	}
	if len(p) != 3 || p[2] != "archive" || r.Method != "PUT" {
		return apiError{404, "NOT_FOUND", "接口不存在"}
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = tx.QueryRow(ctx, "SELECT status FROM deployments WHERE id=$1 FOR UPDATE", p[1]).Scan(&status); e != nil {
		return e
	}
	if status != "UPLOADING" {
		return apiError{409, "INVALID_STATE", "任务已接收上传或已结束"}
	}
	if e = a.checkCapacity(ctx, tx); e != nil {
		return e
	}
	if e = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Minute)); e != nil {
		log.Printf("upload deadline: %v", e)
	}
	defer http.NewResponseController(w).SetReadDeadline(time.Time{})
	filename := filepath.Join(a.data, "uploads", p[1]+".zip")
	f, e := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	_, copyErr := io.Copy(f, r.Body)
	syncErr := f.Sync()
	f.Close()
	if copyErr != nil || syncErr != nil {
		os.Remove(filename)
		_, e = tx.Exec(ctx, "UPDATE deployments SET status='FAILED',error_message='上传中断、文件超限或存储空间不足',updated_at=now() WHERE id=$1", p[1])
		if e == nil {
			e = tx.Commit(ctx)
		}
		if e != nil {
			return e
		}
		return apiError{422, "UPLOAD_FAILED", "上传中断、文件超限或存储空间不足，请重试"}
	}
	_, e = tx.Exec(ctx, "UPDATE deployments SET status='QUEUED',updated_at=now() WHERE id=$1", p[1])
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	w.WriteHeader(http.StatusAccepted)
	write(w, map[string]any{"id": p[1], "status": "QUEUED"})
	return nil
}
func (a *app) worker(ctx context.Context) {
	for {
		func() {
			conn, e := a.db.Acquire(ctx)
			if e != nil {
				return
			}
			defer conn.Release()
			var locked bool
			if e = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(92387412)").Scan(&locked); e != nil || !locked {
				return
			}
			defer conn.Exec(ctx, "SELECT pg_advisory_unlock(92387412)")
			a.cleanupJobs(ctx, conn)
			conn.Exec(ctx, "UPDATE deployments SET status='FAILED',error_message='处理进程中断，请重新上传',updated_at=now() WHERE status IN ('VALIDATING','PREPARING')")
			for {
				conn.Exec(ctx, "UPDATE deployments SET status='FAILED',error_message='上传超时，请重试',updated_at=now() WHERE id IN (SELECT id FROM deployments WHERE status='UPLOADING' AND updated_at<now()-interval '10 minutes' FOR UPDATE SKIP LOCKED)")
				var id, pid, uid, mode string
				e = conn.QueryRow(ctx, "UPDATE deployments SET status='VALIDATING',updated_at=now() WHERE id=(SELECT id FROM deployments WHERE status='QUEUED' ORDER BY created_at LIMIT 1) RETURNING id,project_id,operator_id,route_mode").Scan(&id, &pid, &uid, &mode)
				if e != nil {
					break
				}
				stage := filepath.Join(a.data, "staging", id)
				archive := filepath.Join(a.data, "uploads", id+".zip")
				os.RemoveAll(stage)
				e = os.MkdirAll(stage, 0700)
				if e == nil {
					e = a.checkCapacity(ctx, conn)
				}
				if e == nil {
					e = unpack(archive, stage)
				}
				if e == nil {
					var next bool
					next, e = isNextStaticExport(stage)
					if next {
						mode = "static"
					}
				}
				if e == nil && env("PUBLIC_URL_MODE", "path") == "path" {
					var pub string
					e = conn.QueryRow(ctx, "SELECT public_id FROM projects WHERE id=$1", pid).Scan(&pub)
					if e == nil && !legacyPublicPattern.MatchString(pub) {
						e = adaptPathResources(stage, "/"+pub+"/")
					}
				}
				if e == nil {
					_, e = conn.Exec(ctx, "UPDATE deployments SET status='PREPARING',updated_at=now() WHERE id=$1", id)
				}
				release := filepath.Join(a.data, "releases", pid, id)
				if e == nil {
					e = os.MkdirAll(filepath.Dir(release), 0700)
				}
				if e == nil {
					e = os.Rename(stage, release)
				}
				if e == nil {
					tx, te := conn.Begin(ctx)
					if te != nil {
						e = te
					} else {
						var state, owner string
						te = tx.QueryRow(ctx, "SELECT status FROM users WHERE id=$1 FOR UPDATE", uid).Scan(&state)
						if te == nil {
							te = tx.QueryRow(ctx, "SELECT owner_id FROM projects WHERE id=$1 FOR UPDATE", pid).Scan(&owner)
						}
						if te == nil && (state != "active" || owner != uid) {
							te = fmt.Errorf("账号已停用或项目权限已变更")
						}
						if te == nil {
							_, te = tx.Exec(ctx, "INSERT INTO releases(id,project_id,deployment_id,route_mode) VALUES($1,$2,$1,$3)", id, pid, mode)
						}
						if te == nil {
							_, te = tx.Exec(ctx, "UPDATE projects SET current_release_id=$1,last_published_at=now() WHERE id=$2", id, pid)
						}
						if te == nil {
							_, te = tx.Exec(ctx, "UPDATE deployments SET status='SUCCEEDED',updated_at=now() WHERE id=$1", id)
						}
						if te == nil {
							_, te = tx.Exec(ctx, "INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,'publish',$2)", uid, pid)
						}
						if te == nil {
							te = tx.Commit(ctx)
						} else {
							tx.Rollback(ctx)
						}
						e = te
					}
				}
				if e != nil {
					log.Printf("deployment %s: %v", id, e)
					message := e.Error()
					var pe *os.PathError
					var le *os.LinkError
					if errors.As(e, &pe) || errors.As(e, &le) || len(message) > 200 || strings.Contains(message, "ERROR:") {
						message = "发布处理失败或存储空间不足，请联系管理员"
					}
					conn.Exec(ctx, "UPDATE deployments SET status='FAILED',error_message=$2,updated_at=now() WHERE id=$1 AND status<>'SUCCEEDED'", id, message)
				}
				os.Remove(archive)
				os.RemoveAll(stage)
			}
		}()
		time.Sleep(time.Second)
	}
}
