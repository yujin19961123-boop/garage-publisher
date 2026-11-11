package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func putUsageFile(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte(content), 0600); e != nil {
		t.Fatal(e)
	}
}

func TestMemberStorageRetainedTemporaryAndCleanup(t *testing.T) {
	root := t.TempDir()
	pid, other, did := token(), token(), token()
	for name, content := range map[string]string{
		"releases/" + pid + "/old/index.html": "12345", "releases/" + pid + "/old/.garage-manifest.json": "123",
		"releases/" + pid + "/old/assets/app.js": "1234567", "releases/" + pid + "/current/index.html": "12345678901",
		"uploads/" + did + ".zip": "123", "uploads/" + did + ".zip.part": "1234",
		"staging/" + did + "/index.html": "12345", "staging/" + did + ".normalized/index.html": "123456",
		"releases/" + other + "/current/index.html": strings.Repeat("x", 17),
		"releases/unowned/index.html":               strings.Repeat("x", 100), "uploads/unowned.zip": "ignore", "staging/unowned/index.html": "ignore",
	} {
		putUsageFile(t, root, name, content)
	}
	projects := map[string]string{pid: "owner", other: "other"}
	deployments := map[string]string{did: "owner"}
	usage, e := scanMemberStorage(context.Background(), root, projects, deployments)
	if e != nil || usage["owner"] != 44 || usage["other"] != 17 {
		t.Fatalf("wrong attributed totals: %v %v", usage, e)
	}
	if e = os.Remove(filepath.Join(root, "uploads", did+".zip")); e != nil {
		t.Fatal(e)
	}
	usage, e = scanMemberStorage(context.Background(), root, projects, deployments)
	if e != nil || usage["owner"] != 41 {
		t.Fatalf("cleanup must reduce actual usage: %v %v", usage, e)
	}
}

func TestMemberStorageMissingAndCancelled(t *testing.T) {
	usage, e := scanMemberStorage(context.Background(), filepath.Join(t.TempDir(), "missing"), nil, nil)
	if e != nil || len(usage) != 0 {
		t.Fatalf("empty storage: %v %v", usage, e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = scanMemberStorage(ctx, t.TempDir(), nil, nil); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", e)
	}
}

func TestMemberStorageRejectsLinks(t *testing.T) {
	for _, ancestor := range []bool{false, true} {
		t.Run(map[bool]string{false: "file link", true: "directory link"}[ancestor], func(t *testing.T) {
			root, outside := t.TempDir(), t.TempDir()
			pid := token()
			putUsageFile(t, outside, "secret", "not a member file")
			link, target := filepath.Join(root, "releases", pid, "secret"), filepath.Join(outside, "secret")
			if ancestor {
				link, target = filepath.Join(root, "releases"), outside
			}
			if e := os.MkdirAll(filepath.Dir(link), 0700); e != nil {
				t.Fatal(e)
			}
			if e := os.Symlink(target, link); e != nil {
				t.Skip("OS does not permit test symlinks")
			}
			if usage, e := scanMemberStorage(context.Background(), root, map[string]string{pid: "owner"}, nil); e == nil || usage != nil {
				t.Fatalf("link accepted: %v %v", usage, e)
			}
		})
	}
}

func memberLogin(f *versionsFixture, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"username": "version_owner", "password": password})
	r := httptest.NewRequest("POST", "http://console.localhost:8080/api/v1/auth/login", strings.NewReader(string(body)))
	r.RemoteAddr = token() + ":1234"
	w := httptest.NewRecorder()
	if e := f.a.login(w, r); e != nil {
		fail(w, e)
	}
	return w
}

func TestMemberLoginCountsSuccessOnlyAndPersists(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	f.exec("UPDATE users SET password_hash=$1 WHERE id=$2", hashPassword("123456"), f.owner)
	var since time.Time
	if e := f.a.db.QueryRow(f.ctx, "SELECT login_stats_since FROM users WHERE id=$1", f.owner).Scan(&since); e != nil {
		t.Fatal(e)
	}
	if w := memberLogin(f, "wrong"); w.Code != 401 {
		t.Fatalf("wrong password: %d", w.Code)
	}
	if f.scalar("SELECT login_count FROM users WHERE id=$1", f.owner) != 0 {
		t.Fatal("failed login counted")
	}
	f.exec("UPDATE users SET status='disabled' WHERE id=$1", f.owner)
	if w := memberLogin(f, "123456"); w.Code != 401 {
		t.Fatalf("disabled user: %d", w.Code)
	}
	f.exec("UPDATE users SET status='active' WHERE id=$1", f.owner)
	w := memberLogin(f, "123456")
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("successful login: %d", w.Code)
	}
	// Reading /me and refreshing an authenticated page are not new logins.
	r := httptest.NewRequest("GET", "http://console.localhost:8080/api/v1/me", nil)
	r.AddCookie(w.Result().Cookies()[0])
	for n := 0; n < 3; n++ {
		result := httptest.NewRecorder()
		f.a.ServeHTTP(result, r)
		if result.Code != 200 {
			t.Fatalf("me: %d", result.Code)
		}
	}
	if f.scalar("SELECT login_count FROM users WHERE id=$1", f.owner) != 1 {
		t.Fatal("session reads changed counter")
	}
	var wg sync.WaitGroup
	codes := make(chan int, 3)
	for n := 0; n < 3; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- memberLogin(f, "123456").Code }()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 200 {
			t.Fatalf("concurrent login: %d", code)
		}
	}
	if f.scalar("SELECT login_count FROM users WHERE id=$1", f.owner) != 4 {
		t.Fatal("concurrent increments lost")
	}
	var last time.Time
	if e := f.a.db.QueryRow(f.ctx, "SELECT last_login_at FROM users WHERE id=$1", f.owner).Scan(&last); e != nil || last.Before(since) {
		t.Fatal("missing last login", e)
	}
	f.exec(schema) // Simulate restart: counters, timestamp and baseline survive.
	var afterSince, afterLast time.Time
	if e := f.a.db.QueryRow(f.ctx, "SELECT login_stats_since,last_login_at FROM users WHERE id=$1", f.owner).Scan(&afterSince, &afterLast); e != nil {
		t.Fatal(e)
	}
	if f.scalar("SELECT login_count FROM users WHERE id=$1", f.owner) != 4 || !since.Equal(afterSince) || !last.Equal(afterLast) {
		t.Fatal("migration reset login history")
	}
}

func TestMemberLoginSessionFailureRollsBackStatistics(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	f.exec("UPDATE users SET password_hash=$1 WHERE id=$2", hashPassword("123456"), f.owner)
	f.exec(`CREATE FUNCTION reject_test_session() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test session failure'; END$$; CREATE TRIGGER reject_test_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION reject_test_session();`)
	w := memberLogin(f, "123456")
	if w.Code != 500 || len(w.Result().Cookies()) != 0 {
		t.Fatalf("failed transaction accepted: %d", w.Code)
	}
	if f.scalar("SELECT login_count FROM users WHERE id=$1", f.owner) != 0 || f.scalar("SELECT count(*) FROM users WHERE last_login_at IS NOT NULL") != 0 {
		t.Fatal("failed session mutated statistics")
	}
}

func TestMemberStatsAdminOnlyAndPendingDeletion(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	admin := token()
	f.exec("INSERT INTO users(id,username,password_hash,role) VALUES($1,'metrics_admin','unused','admin')", admin)
	deleted, did := token(), token()
	f.exec("INSERT INTO project_cleanup_jobs(project_id,deployment_ids) VALUES($1,$2)", deleted, []string{did})
	f.exec("INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,'delete_project',$2)", f.owner, deleted)
	f.exec(schema) // Backfill old cleanup ownership from its deletion audit.
	putUsageFile(t, f.a.data, "releases/"+f.pid+"/current/index.html", "12345")
	putUsageFile(t, f.a.data, "releases/"+deleted+"/old/index.html", "1234567")
	putUsageFile(t, f.a.data, "uploads/"+did+".zip.part", "123")
	putUsageFile(t, f.a.data, "staging/"+did+"/index.html", "12")
	call := func(uid string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://console.localhost:8080/api/v1/admin/users", nil)
		if uid != "" {
			raw := token()
			f.exec("INSERT INTO sessions(token,user_id,auth_version,csrf,expires_at) VALUES($1,$2,1,'test',now()+interval '1 hour')", digest(raw), uid)
			r.AddCookie(&http.Cookie{Name: f.a.sessionCookieName(), Value: raw})
		}
		w := httptest.NewRecorder()
		f.a.ServeHTTP(w, r)
		return w
	}
	if w := call(""); w.Code != 401 {
		t.Fatalf("anonymous: %d", w.Code)
	}
	if w := call(f.owner); w.Code != 403 {
		t.Fatalf("member can read usage: %d", w.Code)
	}
	w := call(admin)
	if w.Code != 200 {
		t.Fatalf("admin: %d", w.Code)
	}
	var result struct {
		Items    []memberUsage `json:"items"`
		Measured *time.Time    `json:"storageMeasuredAt"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if result.Measured == nil || len(result.Items) != 3 {
		t.Fatal("missing measurement")
	}
	for _, item := range result.Items {
		if item.StorageBytes == nil {
			t.Fatal("missing storage")
		}
		want := int64(0)
		if item.ID == f.owner {
			want = 17
		}
		if *item.StorageBytes != want || item.LoginCount != 0 || item.LastLoginAt != nil {
			t.Fatalf("wrong metrics for %s", item.Username)
		}
	}
	if strings.Contains(w.Body.String(), "password_hash") || strings.Contains(w.Body.String(), "csrf") {
		t.Fatal("sensitive fields exposed")
	}
	if e := cleanupProjectFiles(f.a.data, deleted, []string{did}); e != nil {
		t.Fatal(e)
	}
	items, _, e := f.a.memberUsage(f.ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, item := range items {
		if item.ID == f.owner && (item.StorageBytes == nil || *item.StorageBytes != 5) {
			t.Fatal("cleaned files still counted")
		}
	}
	// An unreadable/misconfigured storage root must not become an apparent zero.
	bad := filepath.Join(t.TempDir(), "file")
	if e = os.WriteFile(bad, []byte("x"), 0600); e != nil {
		t.Fatal(e)
	}
	f.a.data = bad
	items, measured, e := f.a.memberUsage(f.ctx)
	if e != nil || measured != nil {
		t.Fatal("unavailable storage should preserve login metrics", e)
	}
	for _, item := range items {
		if item.StorageBytes != nil {
			t.Fatal("partial storage presented as numeric")
		}
	}
}
