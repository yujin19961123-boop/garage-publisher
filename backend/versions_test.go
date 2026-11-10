package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type versionsFixture struct {
	t                 *testing.T
	ctx               context.Context
	a                 *app
	owner, other, pid string
	releases          []string
}

// Every integration case owns its random schema. Never fall back to public:
// CREATE TABLE IF NOT EXISTS must not accidentally use the developer's tables.
func newVersionsFixture(t *testing.T, migrate bool) *versionsFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set a local TEST_DATABASE_URL to run isolated version integration tests")
	}
	u, e := url.Parse(dsn)
	if e != nil || !(u.Scheme == "postgres" || u.Scheme == "postgresql") {
		t.Fatal("TEST_DATABASE_URL must be a local postgres URL")
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
	default:
		t.Fatal("version integration tests refuse non-local database hosts")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal("cannot parse local TEST_DATABASE_URL")
	}
	localHost := func(host string) bool { return host == "localhost" || host == "127.0.0.1" || host == "::1" }
	if !localHost(cfg.ConnConfig.Host) {
		t.Fatal("effective database host must be local")
	}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		if !localHost(fallback.Host) {
			t.Fatal("database fallback hosts must be local")
		}
	}
	admin, e := pgxpool.NewWithConfig(ctx, cfg.Copy())
	if e != nil {
		t.Fatal(e)
	}
	namespace := "version_test_" + token()[:20]
	quoted := pgx.Identifier{namespace}.Sanitize()
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+quoted); e != nil {
		admin.Close()
		t.Fatal(e)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = namespace
	cfg.MaxConns = 8
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if !strings.HasPrefix(namespace, "version_test_") || len(namespace) != 33 {
			t.Error("refusing invalid fixture schema cleanup")
			return
		}
		if _, e := admin.Exec(cleanupCtx, "DROP SCHEMA "+quoted+" CASCADE"); e != nil {
			t.Error("isolated schema cleanup failed", e)
		}
		admin.Close()
	})
	f := &versionsFixture{t: t, ctx: ctx, a: &app{db: pool, data: t.TempDir(), domain: "localhost", scheme: "http", port: "8080"}, owner: token(), other: token(), pid: token()}
	if migrate {
		f.exec(schema)
	}
	return f
}
func (f *versionsFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, e := f.a.db.Exec(f.ctx, sql, args...); e != nil {
		f.t.Fatal(e)
	}
}
func (f *versionsFixture) seedProject() {
	f.exec("INSERT INTO users(id,username,password_hash) VALUES($1,'version_owner','unused'),($2,'version_other','unused')", f.owner, f.other)
	f.exec("INSERT INTO projects(id,public_id,owner_id,name) VALUES($1,'version-fixture',$2,'Version fixture')", f.pid, f.owner)
}
func (f *versionsFixture) seedRelease(n int, legacy bool) string {
	id := token()
	f.releases = append(f.releases, id)
	at := time.Date(2025, 1, n, 1, 0, 0, 0, time.UTC)
	f.exec("INSERT INTO deployments(id,project_id,operator_id,status,route_mode,created_at) VALUES($1,$2,$3,'SUCCEEDED','static',$4)", id, f.pid, f.owner, at)
	if legacy {
		f.exec("INSERT INTO releases(id,project_id,deployment_id,route_mode,created_at) VALUES($1,$2,$1,'static',$3)", id, f.pid, at)
	} else {
		f.exec("INSERT INTO releases(id,project_id,deployment_id,route_mode,version_number,created_at) VALUES($1,$2,$1,'static',$3,$4)", id, f.pid, n, at)
	}
	dir := filepath.Join(f.a.data, "releases", f.pid, id)
	if e := os.MkdirAll(dir, 0700); e != nil {
		f.t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "index.html"), []byte(fmt.Sprintf("<h1>Version %d</h1>", n)), 0600); e != nil {
		f.t.Fatal(e)
	}
	if !legacy {
		if e := writeVersionManifest(dir); e != nil {
			f.t.Fatal(e)
		}
	}
	return id
}
func (f *versionsFixture) current(id string) {
	f.exec("UPDATE projects SET current_release_id=$1,last_published_at=now() WHERE id=$2", id, f.pid)
}
func (f *versionsFixture) scalar(sql string, args ...any) int {
	f.t.Helper()
	var n int
	if e := f.a.db.QueryRow(f.ctx, sql, args...).Scan(&n); e != nil {
		f.t.Fatal(e)
	}
	return n
}
func (f *versionsFixture) ownerIdentity() identity {
	return identity{user: user{ID: f.owner, Username: "version_owner", Role: "member", Status: "active"}}
}
func (f *versionsFixture) activate(id, expected string, who identity) int {
	f.t.Helper()
	body, _ := json.Marshal(map[string]string{"expectedCurrentReleaseId": expected})
	r := httptest.NewRequest("POST", "http://console.localhost:8080/api/v1/projects/"+f.pid+"/versions/"+id+"/activate", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	if e := f.a.activateVersion(w, r, who, f.pid, id); e != nil {
		fail(w, e)
	}
	return w.Code
}

func TestVersionsLegacyMigrationIdempotent(t *testing.T) {
	f := newVersionsFixture(t, false)
	// Model the real pre-version tables before applying today's full migration.
	f.exec(`CREATE TABLE users(id text PRIMARY KEY,username text UNIQUE NOT NULL,password_hash text NOT NULL,role text NOT NULL DEFAULT 'member',status text NOT NULL DEFAULT 'active',auth_version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());CREATE TABLE projects(id text PRIMARY KEY,public_id text UNIQUE NOT NULL,owner_id text NOT NULL REFERENCES users(id),name text NOT NULL,current_release_id text,last_published_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());CREATE TABLE deployments(id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),operator_id text NOT NULL REFERENCES users(id),status text NOT NULL,route_mode text NOT NULL,error_message text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());CREATE TABLE releases(id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),deployment_id text UNIQUE NOT NULL REFERENCES deployments(id),route_mode text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`)
	f.seedProject()
	for n := 1; n <= 3; n++ {
		f.seedRelease(n, true)
	}
	f.current(f.releases[2])
	f.exec(schema)
	f.exec(schema)
	for n, id := range f.releases {
		if got := f.scalar("SELECT version_number FROM releases WHERE id=$1", id); got != n+1 {
			t.Fatalf("legacy version number %d want %d", got, n+1)
		}
	}
	if e := f.a.reconcileVersions(f.ctx, f.a.db); e != nil {
		t.Fatal(e)
	}
	for _, id := range f.releases {
		if e := validateVersionFiles(f.a.data, f.pid, id); e != nil {
			t.Fatal("legacy manifest was not bootstrapped", e)
		}
	}
}

func TestVersionsRetentionPreservesCurrentAndFiveTotal(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	for n := 1; n <= 7; n++ {
		f.seedRelease(n, false)
	}
	f.current(f.releases[0])
	for attempt := 0; attempt < 2; attempt++ {
		tx, e := f.a.db.Begin(f.ctx)
		if e != nil {
			t.Fatal(e)
		}
		if e = expireVersions(f.ctx, tx, f.pid); e != nil {
			tx.Rollback(f.ctx)
			t.Fatal(e)
		}
		if e = tx.Commit(f.ctx); e != nil {
			t.Fatal(e)
		}
	}
	if got := f.scalar("SELECT count(*) FROM releases WHERE project_id=$1 AND expired_at IS NULL", f.pid); got != 5 {
		t.Fatalf("retained %d want 5", got)
	}
	for _, index := range []int{0, 3, 4, 5, 6} {
		if f.scalar("SELECT count(*) FROM releases WHERE id=$1 AND expired_at IS NULL", f.releases[index]) != 1 {
			t.Fatalf("version %d incorrectly expired", index+1)
		}
	}
	if got := f.scalar("SELECT count(*) FROM version_cleanup_jobs WHERE project_id=$1", f.pid); got != 2 {
		t.Fatalf("expected exactly two idempotent cleanup jobs, got %d", got)
	}
}

func TestVersionsCleanupProtectsCurrentAndActive(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	for n := 1; n <= 3; n++ {
		f.seedRelease(n, false)
	}
	f.current(f.releases[2])
	for _, id := range f.releases {
		f.exec("UPDATE releases SET expired_at=now() WHERE id=$1", id)
		f.exec("INSERT INTO version_cleanup_jobs(project_id,deployment_id) VALUES($1,$2)", f.pid, id)
	}
	f.exec("UPDATE deployments SET status='VALIDATING' WHERE id=$1", f.releases[1])
	os.RemoveAll(filepath.Join(f.a.data, "releases", f.pid, f.releases[0]))
	f.a.cleanupVersionJobs(f.ctx, f.a.db)
	if f.scalar("SELECT count(*) FROM releases WHERE id=$1 AND cleaned_at IS NOT NULL", f.releases[0]) != 1 {
		t.Fatal("already-missing files did not complete cleanup")
	}
	for _, index := range []int{1, 2} {
		if _, e := os.Stat(filepath.Join(f.a.data, "releases", f.pid, f.releases[index], "index.html")); e != nil {
			t.Fatal("cleanup removed active/current version", e)
		}
	}
	f.exec("UPDATE deployments SET status='SUCCEEDED' WHERE id=$1", f.releases[1])
	f.a.cleanupVersionJobs(f.ctx, f.a.db)
	f.a.cleanupVersionJobs(f.ctx, f.a.db)
	if f.scalar("SELECT count(*) FROM releases WHERE id=$1 AND cleaned_at IS NOT NULL", f.releases[1]) != 1 {
		t.Fatal("deferred cleanup did not retry")
	}
	if _, e := os.Stat(filepath.Join(f.a.data, "releases", f.pid, f.releases[2], "index.html")); e != nil {
		t.Fatal("current version lost on retry", e)
	}
}

func TestVersionsActivationOwnershipAndStaleCurrent(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	for n := 1; n <= 3; n++ {
		f.seedRelease(n, false)
	}
	f.current(f.releases[2])
	other := identity{user: user{ID: f.other, Role: "admin", Status: "active"}}
	if status := f.activate(f.releases[0], f.releases[2], other); status != 403 {
		t.Fatalf("other admin activate status %d", status)
	}
	if status := f.activate(f.releases[0], f.releases[1], f.ownerIdentity()); status != 409 {
		t.Fatalf("stale activation status %d", status)
	}
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for _, target := range f.releases[:2] {
		wg.Add(1)
		go func(id string) { defer wg.Done(); statuses <- f.activate(id, f.releases[2], f.ownerIdentity()) }(target)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent activation results %v", counts)
	}
}

func TestVersionsManifestDetectsSameSizeTampering(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	id := f.seedRelease(1, false)
	if e := validateVersionFiles(f.a.data, f.pid, id); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(f.a.data, "releases", f.pid, id, "index.html")
	data, e := os.ReadFile(p)
	if e != nil {
		t.Fatal(e)
	}
	data[0] ^= 1
	if e = os.WriteFile(p, data, 0600); e != nil {
		t.Fatal(e)
	}
	if e = validateVersionFiles(f.a.data, f.pid, id); e == nil {
		t.Fatal("manifest accepted same-sized modified file")
	}
}

func TestVersionsCleanupPathBounds(t *testing.T) {
	data := t.TempDir()
	pid, did := token(), token()
	targets, e := versionCleanupTargets(data, pid, did)
	if e != nil || len(targets) == 0 {
		t.Fatalf("valid cleanup paths %v %v", targets, e)
	}
	for _, p := range targets {
		rel, e := filepath.Rel(data, p)
		if e != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			t.Fatal("cleanup target escaped project data", p)
		}
	}
	for _, bad := range []string{"", "..", "../escape", strings.Repeat("a", 47), strings.Repeat("A", 48)} {
		if _, e := versionCleanupTargets(data, bad, did); e == nil {
			t.Fatal("accepted invalid project identifier", bad)
		}
		if _, e := versionCleanupTargets(data, pid, bad); e == nil {
			t.Fatal("accepted invalid deployment identifier", bad)
		}
	}
}

func TestVersionsHistoryPaginationAndOwnerBoundary(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	for n := 1; n <= 3; n++ {
		f.seedRelease(n, false)
	}
	f.current(f.releases[2])
	for n := 0; n < 22; n++ {
		f.exec("INSERT INTO deployments(id,project_id,operator_id,status,route_mode,error_message,created_at) VALUES($1,$2,$3,'FAILED','static','fixture failure','2025-02-01T00:00:00Z')", token(), f.pid, f.owner)
	}
	request := func(cursor string, who identity) (int, map[string]any) {
		r := httptest.NewRequest("GET", "http://console.localhost:8080/api/v1/projects/"+f.pid+"/deployments"+cursor, nil)
		w := httptest.NewRecorder()
		if e := f.a.deploymentHistory(w, r, who, f.pid); e != nil {
			fail(w, e)
		}
		var result map[string]any
		json.Unmarshal(w.Body.Bytes(), &result)
		return w.Code, result
	}
	other := identity{user: user{ID: f.other, Role: "admin", Status: "active"}}
	if status, _ := request("", other); status != 403 {
		t.Fatalf("other admin history status %d", status)
	}
	status, first := request("", f.ownerIdentity())
	if status != 200 {
		t.Fatal("first history page status", status)
	}
	items, ok := first["items"].([]any)
	if !ok || len(items) != 20 {
		t.Fatal("history first-page size", first)
	}
	cursor, ok := first["nextCursor"].(string)
	if !ok || cursor == "" {
		t.Fatal("history next cursor missing")
	}
	status, second := request("?cursor="+url.QueryEscape(cursor), f.ownerIdentity())
	if status != 200 {
		t.Fatal("second history page status", status)
	}
	rest, ok := second["items"].([]any)
	if !ok || len(rest) != 5 {
		t.Fatal("history second-page size", second)
	}
	seen := map[string]bool{}
	for _, item := range append(items, rest...) {
		id := item.(map[string]any)["id"].(string)
		if seen[id] {
			t.Fatal("history pagination repeated record", id)
		}
		seen[id] = true
	}
	if second["nextCursor"] != nil {
		t.Fatal("unexpected third page")
	}
	r := httptest.NewRequest("GET", "http://console.localhost:8080/api/v1/projects/"+f.pid+"/versions", nil)
	w := httptest.NewRecorder()
	if e := f.a.versionList(w, r, other, f.pid); e != nil {
		fail(w, e)
	}
	if w.Code != 403 {
		t.Fatal("other admin versions status", w.Code)
	}
}

func TestVersionsCurrentReleaseDifferentFromDeploymentIDProtected(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	did := f.seedRelease(1, false)
	rid := token()
	f.exec("UPDATE releases SET id=$1,expired_at=now() WHERE id=$2", rid, did)
	f.current(rid)
	dir := filepath.Join(f.a.data, "releases", f.pid, rid)
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("current"), 0600)
	if e := writeVersionManifest(dir); e != nil {
		t.Fatal(e)
	}
	f.exec("INSERT INTO version_cleanup_jobs(project_id,deployment_id) VALUES($1,$2)", f.pid, did)
	f.a.cleanupVersionJobs(f.ctx, f.a.db)
	if f.scalar("SELECT count(*) FROM releases WHERE id=$1 AND cleaned_at IS NOT NULL", rid) != 0 {
		t.Fatal("cleanup marked the current release as cleaned because release ID differs from deployment ID")
	}
	if _, e := os.Stat(filepath.Join(dir, "index.html")); e != nil {
		t.Fatal("current release files lost", e)
	}
}

func TestVersionsActivationRejectsMissingExpiredAndBusy(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	for n := 1; n <= 3; n++ {
		f.seedRelease(n, false)
	}
	f.current(f.releases[2])
	missing := filepath.Join(f.a.data, "releases", f.pid, f.releases[0], "index.html")
	if e := os.Remove(missing); e != nil {
		t.Fatal(e)
	}
	if status := f.activate(f.releases[0], f.releases[2], f.ownerIdentity()); status != 409 {
		t.Fatalf("missing files activation status %d", status)
	}
	if e := os.WriteFile(missing, []byte("<h1>Version 1</h1>"), 0600); e != nil {
		t.Fatal(e)
	}
	f.exec("UPDATE releases SET expired_at=now() WHERE id=$1", f.releases[1])
	if status := f.activate(f.releases[1], f.releases[2], f.ownerIdentity()); status != 409 {
		t.Fatalf("expired activation status %d", status)
	}
	if status := f.activate(token(), f.releases[2], f.ownerIdentity()); status != 404 {
		t.Fatalf("unknown release status %d", status)
	}
	f.exec("INSERT INTO deployments(id,project_id,operator_id,status,route_mode) VALUES($1,$2,$3,'QUEUED','static')", token(), f.pid, f.owner)
	if status := f.activate(f.releases[0], f.releases[2], f.ownerIdentity()); status != 409 {
		t.Fatalf("busy activation status %d", status)
	}
	if f.scalar("SELECT count(*) FROM projects WHERE id=$1 AND current_release_id=$2", f.pid, f.releases[2]) != 1 {
		t.Fatal("rejected activation changed current release")
	}
}

func TestVersionsFailedDeploymentCleanupAndUnsafeJobRetry(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	did := token()
	f.exec("INSERT INTO deployments(id,project_id,operator_id,status,route_mode) VALUES($1,$2,$3,'FAILED','static')", did, f.pid, f.owner)
	dir := filepath.Join(f.a.data, "staging", did)
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "partial.html"), []byte("partial"), 0600)
	if e := f.a.reconcileVersions(f.ctx, f.a.db); e != nil {
		t.Fatal(e)
	}
	if f.scalar("SELECT count(*) FROM version_cleanup_jobs WHERE deployment_id=$1", did) != 1 {
		t.Fatal("failed task did not get cleanup job")
	}
	f.a.cleanupVersionJobs(f.ctx, f.a.db)
	if _, e := os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("failed task staging files remain", e)
	}
	if f.scalar("SELECT count(*) FROM deployments WHERE id=$1 AND files_cleaned_at IS NOT NULL", did) != 1 {
		t.Fatal("failed task not marked cleaned")
	}
	unsafe := "bad-path-identifier"
	f.exec("INSERT INTO deployments(id,project_id,operator_id,status,route_mode) VALUES($1,$2,$3,'FAILED','static')", unsafe, f.pid, f.owner)
	f.exec("INSERT INTO version_cleanup_jobs(project_id,deployment_id) VALUES($1,$2)", f.pid, unsafe)
	for n := 0; n < 2; n++ {
		f.a.cleanupVersionJobs(f.ctx, f.a.db)
	}
	if attempts := f.scalar("SELECT attempts FROM version_cleanup_jobs WHERE deployment_id=$1", unsafe); attempts != 2 {
		t.Fatalf("unsafe job not retained for retry: attempts %d", attempts)
	}
	if f.scalar("SELECT count(*) FROM deployments WHERE id=$1 AND files_cleaned_at IS NULL", unsafe) != 1 {
		t.Fatal("unsafe cleanup was falsely marked complete")
	}
}

func TestVersionsActivationRestoresRouteMode(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	static := f.seedRelease(1, false)
	spa := f.seedRelease(2, false)
	f.exec("UPDATE releases SET route_mode='spa' WHERE id=$1", spa)
	f.current(static)
	preview := func(want int) {
		r := httptest.NewRequest("GET", "http://localhost:8080/unknown/nested/page", nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		f.a.preview(w, r, "version-fixture")
		if w.Code != want {
			t.Fatalf("preview status %d want %d: %s", w.Code, want, w.Body.String())
		}
	}
	preview(404)
	if status := f.activate(spa, static, f.ownerIdentity()); status != 200 {
		t.Fatal("SPA activation status", status)
	}
	preview(200)
	if status := f.activate(static, spa, f.ownerIdentity()); status != 200 {
		t.Fatal("static activation status", status)
	}
	preview(404)
}

func TestVersionsManifestInterruptedWrite(t *testing.T) {
	data := t.TempDir()
	pid, rid := token(), token()
	root := filepath.Join(data, "releases", pid, rid)
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "index.html"), []byte("<h1>complete version</h1>"), 0600); e != nil {
		t.Fatal(e)
	}
	temporary := filepath.Join(root, ".garage-manifest.tmp")
	if e := os.WriteFile(temporary, []byte(`{"files":[{"path":"index.html"`), 0600); e != nil {
		t.Fatal(e)
	}
	if e := writeVersionManifest(root); e != nil {
		t.Fatal("interrupted manifest was not recovered", e)
	}
	if e := validateVersionFiles(data, pid, rid); e != nil {
		t.Fatal("recovered manifest invalid", e)
	}
	if _, e := os.Stat(temporary); !os.IsNotExist(e) {
		t.Fatal("temporary manifest remains", e)
	}
}

func TestVersionsManifestRejectsUnrecordedFiles(t *testing.T) {
	data := t.TempDir()
	pid, rid := token(), token()
	root := filepath.Join(data, "releases", pid, rid)
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "index.html"), []byte("<h1>original</h1>"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := writeVersionManifest(root); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "unexpected.js"), []byte("alert('extra')"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := validateVersionFiles(data, pid, rid); e == nil {
		t.Fatal("accepted an unrecorded release file")
	}
	if e := os.Remove(filepath.Join(root, "unexpected.js")); e != nil {
		t.Fatal(e)
	}
	if e := validateVersionFiles(data, pid, rid); e != nil {
		t.Fatal("unchanged original release rejected", e)
	}
}
