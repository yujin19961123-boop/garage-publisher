package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func orderIDs(c projectCollection) []string {
	ids := []string{}
	for _, p := range c.Items {
		ids = append(ids, p["id"].(string))
	}
	return ids
}
func (f *versionsFixture) orderCollection(who identity) projectCollection {
	f.t.Helper()
	c, e := f.a.projectCollection(httptest.NewRequest("GET", "http://console.localhost:8080/api/v1/projects", nil), who, "")
	if e != nil {
		f.t.Fatal(e)
	}
	return c
}
func (f *versionsFixture) saveOrderFor(who identity, ids []string, mode string, revision int64) int {
	data, _ := json.Marshal(map[string]any{"mode": mode, "projectIds": ids, "expectedRevision": revision})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("PUT", "/api/v1/projects/order", strings.NewReader(string(data)))
	if e := f.a.projects(w, r, who, []string{"projects", "order"}); e != nil {
		fail(w, e)
	}
	return w.Code
}
func (f *versionsFixture) addOrderProject(owner, name, slug, created, updated string) string {
	id := token()
	f.exec("INSERT INTO projects(id,public_id,owner_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)", id, slug, owner, name, created, updated)
	return id
}
func checkIDs(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v want %v", got, want)
	}
}
func TestProjectOrderUpdatedAndNameChange(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	who := f.ownerIdentity()
	f.exec("UPDATE projects SET created_at='2025-03-01',updated_at='2025-01-01' WHERE id=$1", f.pid)
	b := f.addOrderProject(f.owner, "Beta", "beta", "2025-01-01", "2025-02-01")
	c := f.orderCollection(who)
	checkIDs(t, orderIDs(c), []string{b, f.pid})
	if c.SortMode != "updated" || c.SortRevision != 0 {
		t.Fatal(c)
	}
	r := httptest.NewRequest("PATCH", "/api/v1/projects/"+f.pid, strings.NewReader(`{"name":"Renamed"}`))
	w := httptest.NewRecorder()
	if e := f.a.projects(w, r, who, []string{"projects", f.pid}); e != nil {
		t.Fatal(e)
	}
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{f.pid, b})
	var before, after time.Time
	f.a.db.QueryRow(f.ctx, "SELECT updated_at FROM projects WHERE id=$1", f.pid).Scan(&before)
	if e := f.a.projects(httptest.NewRecorder(), httptest.NewRequest("PATCH", "/", strings.NewReader(`{"name":"Renamed"}`)), who, []string{"projects", f.pid}); e != nil {
		t.Fatal(e)
	}
	f.a.db.QueryRow(f.ctx, "SELECT updated_at FROM projects WHERE id=$1", f.pid).Scan(&after)
	if !before.Equal(after) {
		t.Fatal("unchanged name changed recency")
	}
}
func TestProjectOrderManualShareAndIsolation(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	who := f.ownerIdentity()
	b := f.addOrderProject(f.owner, "Beta", "beta", "2025-01-01", "2025-02-01")
	draft := f.addOrderProject(f.owner, "Draft", "draft", "2025-01-01", "2025-03-01")
	f.exec("UPDATE projects SET current_release_id='test-release',last_published_at=now() WHERE id=ANY($1::text[])", []string{f.pid, b})
	f.exec("INSERT INTO share_pages(owner_id,public_id) VALUES($1,'owner-share')", f.owner)
	if code := f.saveOrderFor(who, []string{f.pid, draft, b}, "manual", 0); code != 200 {
		t.Fatal(code)
	}
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{f.pid, draft, b})
	checkShare := func() {
		t.Helper()
		w := httptest.NewRecorder()
		f.a.publicSharePage(w, httptest.NewRequest("GET", "http://localhost:8080/_share/owner-share/", nil))
		html := w.Body.String()
		aPos, bPos := strings.Index(html, `href="`+f.a.url("version-fixture")+`"`), strings.Index(html, `href="`+f.a.url("beta")+`"`)
		if w.Code != 200 || aPos < 0 || bPos < aPos || strings.Contains(html, f.a.url("draft")) {
			t.Fatal("share order differs or exposes a draft", w.Code)
		}
	}
	checkShare()
	// An admin's global view order must never change the publisher's collection.
	admin := identity{user: user{ID: f.other, Role: "admin"}}
	if code := f.saveOrderFor(admin, []string{b, draft, f.pid}, "manual", 0); code != 200 {
		t.Fatal(code)
	}
	checkShare()
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{f.pid, draft, b})
	f.exec("UPDATE projects SET updated_at=clock_timestamp() WHERE id=$1", b)
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{f.pid, draft, b})
	fresh := f.addOrderProject(f.owner, "Fresh", "fresh", "2026-11-11", "2026-11-11")
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{fresh, f.pid, draft, b})
	// Project deletion removes order references through its foreign key.
	f.exec("DELETE FROM projects WHERE id=$1", draft)
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{fresh, f.pid, b})
	if f.scalar("SELECT count(*) FROM project_list_order WHERE project_id=$1", draft) != 0 {
		t.Fatal("deleted order reference retained")
	}
	if code := f.saveOrderFor(who, nil, "updated", 1); code != 200 {
		t.Fatal(code)
	}
	checkIDs(t, orderIDs(f.orderCollection(who)), []string{b, f.pid, fresh})
	if f.scalar("SELECT count(*) FROM project_list_order WHERE user_id=$1", f.owner) != 0 {
		t.Fatal("reset retained manual ranks")
	}
}
func TestProjectOrderValidationAndConflict(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	who := f.ownerIdentity()
	other := f.addOrderProject(f.other, "Other", "other", "2025-01-01", "2025-01-01")
	for _, test := range []struct {
		ids      []string
		mode     string
		revision int64
		status   int
	}{{[]string{f.pid, f.pid}, "manual", 0, 422}, {[]string{other}, "manual", 0, 403}, {nil, "manual", 0, 409}, {[]string{f.pid}, "bad", 0, 422}, {[]string{f.pid}, "manual", 0, 200}, {[]string{f.pid}, "manual", 0, 409}} {
		if code := f.saveOrderFor(who, test.ids, test.mode, test.revision); code != test.status {
			t.Fatalf("%v %s got %d want %d", test.ids, test.mode, code, test.status)
		}
	}
	if c := f.orderCollection(who); c.SortRevision != 1 || c.SortMode != "manual" {
		t.Fatal(c)
	}
	if c := f.orderCollection(identity{user: user{ID: f.other, Role: "member"}}); c.SortMode != "updated" || c.SortRevision != 0 {
		t.Fatal("preferences leaked")
	}
}
func TestProjectOrderConcurrentWindows(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	who := f.ownerIdentity()
	b := f.addOrderProject(f.owner, "Beta", "beta", "2025-01-01", "2025-01-01")
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, ids := range [][]string{{f.pid, b}, {b, f.pid}} {
		wg.Add(1)
		go func(ids []string) { defer wg.Done(); codes <- f.saveOrderFor(who, ids, "manual", 0) }(ids)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for c := range codes {
		counts[c]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
	if f.orderCollection(who).SortRevision != 1 || f.scalar("SELECT count(*) FROM project_list_order WHERE user_id=$1", f.owner) != 2 {
		t.Fatal("partial or overwritten order")
	}
}
func TestProjectOrderMigrationIdempotent(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	f.exec("ALTER TABLE projects DROP COLUMN updated_at")
	f.exec("UPDATE projects SET created_at='2025-01-01',last_published_at='2025-02-01' WHERE id=$1", f.pid)
	f.exec(schema)
	var first, second time.Time
	if e := f.a.db.QueryRow(f.ctx, "SELECT updated_at FROM projects WHERE id=$1", f.pid).Scan(&first); e != nil {
		t.Fatal(e)
	}
	f.exec(schema)
	if e := f.a.db.QueryRow(f.ctx, "SELECT updated_at FROM projects WHERE id=$1", f.pid).Scan(&second); e != nil {
		t.Fatal(e)
	}
	if !first.Equal(second) || f.scalar("SELECT count(*) FROM projects WHERE id=$1 AND updated_at=last_published_at", f.pid) != 1 {
		t.Fatal("legacy recency changed on restart", first, second)
	}
}

func TestProjectOrderAuthentication(t *testing.T) {
	f := newVersionsFixture(t, true)
	f.seedProject()
	raw := token()
	f.exec("INSERT INTO sessions(token,user_id,auth_version,csrf,expires_at) VALUES($1,$2,1,'order-csrf',now()+interval '1 hour')", digest(raw), f.owner)
	call := func(cookie, csrf, origin string) int {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("PUT", "http://console.localhost:8080/api/v1/projects/order", strings.NewReader(`{"mode":"updated","expectedRevision":0}`))
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: f.a.sessionCookieName(), Value: cookie})
		}
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Origin", origin)
		if e := f.a.api(w, r); e != nil {
			fail(w, e)
		}
		return w.Code
	}
	if got := call("", "", ""); got != 401 {
		t.Fatal(got)
	}
	if got := call(raw, "", ""); got != 403 {
		t.Fatal(got)
	}
	if got := call(raw, "order-csrf", "http://untrusted.example"); got != 403 {
		t.Fatal(got)
	}
	if got := call(raw, "order-csrf", "http://console.localhost:8080"); got != 200 {
		t.Fatal(got)
	}
	f.exec("UPDATE users SET status='disabled' WHERE id=$1", f.owner)
	if got := call(raw, "order-csrf", ""); got != 401 {
		t.Fatal(got)
	}
}
