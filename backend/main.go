package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"
)

//go:embed schema.sql
var schema string

type app struct {
	db                         *pgxpool.Pool
	data, domain, scheme, port string
}

var loginSlots = make(chan struct{}, 4)
var loginMu sync.Mutex
var loginWindows = map[string]struct {
	count int
	start time.Time
}{}

func allowLogin(key string) bool {
	loginMu.Lock()
	defer loginMu.Unlock()
	now := time.Now()
	for k, v := range loginWindows {
		if now.Sub(v.start) > time.Minute {
			delete(loginWindows, k)
		}
	}
	v := loginWindows[key]
	if v.start.IsZero() {
		v.start = now
	}
	v.count++
	loginWindows[key] = v
	return v.count <= 20
}

type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Status   string `json:"status"`
}
type identity struct {
	user
	CSRF  string
	Token string
}
type apiError struct {
	Status        int
	Code, Message string
}

func (e apiError) Error() string { return e.Message }
func env(k, d string) string {
	if s := os.Getenv(k); s != "" {
		return s
	}
	return d
}
func token() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func digest(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func hashPassword(p string) string {
	s := make([]byte, 16)
	rand.Read(s)
	h := argon2.IDKey([]byte(p), s, 2, 19456, 1, 32)
	return base64.RawStdEncoding.EncodeToString(s) + "." + base64.RawStdEncoding.EncodeToString(h)
}
func checkPassword(p, h string) bool {
	v := strings.Split(h, ".")
	if len(v) != 2 {
		return false
	}
	s, e := base64.RawStdEncoding.DecodeString(v[0])
	if e != nil {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(v[1])
	if e != nil {
		return false
	}
	got := argon2.IDKey([]byte(p), s, 2, 19456, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}
func main() {
	ctx := context.Background()
	db, e := pgxpool.New(ctx, env("DATABASE_URL", "postgres://prototype:prototype@localhost:5432/prototype?sslmode=disable"))
	if e != nil {
		log.Fatal(e)
	}
	defer db.Close()
	if _, e = db.Exec(ctx, schema); e != nil {
		log.Fatal(e)
	}
	a := &app{db: db, data: env("DATA_DIR", "./data"), domain: env("PUBLIC_DOMAIN", "localhost"), scheme: env("PUBLIC_SCHEME", "http"), port: env("PUBLIC_PORT", "8080")}
	for _, p := range []string{"uploads", "staging", "releases"} {
		if e = os.MkdirAll(filepath.Join(a.data, p), 0700); e != nil {
			log.Fatal(e)
		}
	}
	if p := os.Getenv("INIT_ADMIN_PASSWORD"); p != "" {
		if len(p) < 6 {
			log.Fatal("INIT_ADMIN_PASSWORD must contain at least 6 characters")
		}
		_, e = db.Exec(ctx, "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(username) DO NOTHING", token(), env("INIT_ADMIN_USERNAME", "admin"), hashPassword(p))
		if e != nil {
			log.Fatal(e)
		}
	}
	go a.worker(ctx)
	srv := &http.Server{Addr: env("LISTEN_ADDR", ":8081"), Handler: a, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 10 * time.Minute, IdleTimeout: 60 * time.Second}
	log.Printf("listening %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}
func write(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, e error) {
	s, c, m := 500, "INTERNAL_ERROR", "服务器处理失败，请联系管理员"
	var ae apiError
	if errors.As(e, &ae) {
		s, c, m = ae.Status, ae.Code, ae.Message
	} else {
		log.Printf("request error: %v", e)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(s)
	json.NewEncoder(w).Encode(map[string]any{"code": c, "message": m})
}
func body(r *http.Request, v any) error {
	defer r.Body.Close()
	d := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 64<<10))
	if e := d.Decode(v); e != nil {
		return apiError{400, "INVALID_INPUT", "请求内容无效"}
	}
	return nil
}
func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	host := r.Host
	if h, _, e := net.SplitHostPort(host); e == nil {
		host = h
	}
	if r.URL.Path == "/healthz" {
		if e := a.db.Ping(r.Context()); e != nil {
			http.Error(w, "database unavailable", 503)
		} else {
			write(w, map[string]bool{"ok": true})
		}
		return
	}
	allowed := false
	for _, h := range strings.Split(env("ADMIN_HOSTS", "console.localhost,console.byjin.cn"), ",") {
		if host == strings.TrimSpace(h) {
			allowed = true
		}
	}
	if !allowed {
		if host == a.domain && strings.HasPrefix(r.URL.Path, "/_share/") {
			a.publicSharePage(w, r)
			return
		}
		if host == a.domain && env("PUBLIC_URL_MODE", "path") == "path" {
			a.pathPreview(w, r)
			return
		}
		if strings.HasSuffix(host, "."+a.domain) {
			label := strings.TrimSuffix(host, "."+a.domain)
			if strings.HasPrefix(label, "p-") && legacyPublicPattern.MatchString(strings.TrimPrefix(label, "p-")) {
				label = strings.TrimPrefix(label, "p-")
			}
			if publicPattern.MatchString(label) {
				a.preview(w, r, label)
				return
			}
		}
		http.Error(w, "unknown host", http.StatusMisdirectedRequest)
		return
	}
	// Explicit single-domain deployment: Nginx serves the console root/assets,
	// while authenticated API routes retain precedence over public project paths.
	if strings.EqualFold(env("SHARED_ORIGIN", "false"), "true") && host == a.domain && r.URL.Path != "/" && r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/") {
		a.pathPreview(w, r)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if e := a.api(w, r); e != nil {
		fail(w, e)
	}
}
func (a *app) sessionCookieName() string {
	if a.scheme == "https" {
		return "__Host-prototype_session"
	}
	return "prototype_session"
}
func (a *app) authenticate(r *http.Request) (identity, error) {
	var i identity
	c, e := r.Cookie(a.sessionCookieName())
	if e != nil {
		return i, apiError{401, "UNAUTHENTICATED", "请重新登录"}
	}
	i.Token = digest(c.Value)
	e = a.db.QueryRow(r.Context(), `SELECT u.id,u.username,u.role,u.status,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now() AND s.auth_version=u.auth_version AND u.status='active'`, i.Token).Scan(&i.ID, &i.Username, &i.Role, &i.Status, &i.CSRF)
	if e != nil {
		return i, apiError{401, "UNAUTHENTICATED", "请重新登录"}
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(i.CSRF)) != 1 {
			return i, apiError{403, "CSRF_INVALID", "页面已过期，请刷新后重试"}
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != a.scheme+"://"+r.Host {
			return i, apiError{403, "ORIGIN_INVALID", "暂时无法完成操作，请刷新页面后重试"}
		}
	}
	return i, nil
}
func (a *app) api(w http.ResponseWriter, r *http.Request) error {
	p := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	ctx := r.Context()
	if p == "auth/login" && r.Method == "POST" {
		return a.login(w, r)
	}
	i, e := a.authenticate(r)
	if e != nil {
		return e
	}
	if p == "me" && r.Method == "GET" {
		write(w, map[string]any{"user": i.user, "csrfToken": i.CSRF})
		return nil
	}
	if p == "share-page" && (r.Method == "GET" || r.Method == "POST") {
		return a.sharePageAPI(w, r, i)
	}
	if p == "auth/logout" && r.Method == "POST" {
		_, e = a.db.Exec(ctx, "DELETE FROM sessions WHERE token=$1", i.Token)
		http.SetCookie(w, &http.Cookie{Name: a.sessionCookieName(), Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.scheme == "https", SameSite: http.SameSiteLaxMode})
		write(w, map[string]bool{"ok": true})
		return e
	}
	if p == "platform-config" && r.Method == "GET" {
		write(w, map[string]any{"maxUploadBytes": maxUpload, "maxExpandedBytes": maxExpanded, "maxFiles": maxFiles})
		return nil
	}
	parts := strings.Split(p, "/")
	if parts[0] == "projects" {
		return a.projects(w, r, i, parts)
	}
	if parts[0] == "deployments" {
		return a.deploymentAPI(w, r, i, parts)
	}
	if len(parts) > 1 && parts[0] == "admin" && parts[1] == "users" {
		if i.Role != "admin" {
			return apiError{403, "FORBIDDEN", "需要管理员权限"}
		}
		return a.users(w, r, i, parts)
	}
	return apiError{404, "NOT_FOUND", "接口不存在"}
}
func (a *app) login(w http.ResponseWriter, r *http.Request) error {
	if origin := r.Header.Get("Origin"); origin != "" && origin != a.scheme+"://"+r.Host {
		return apiError{403, "ORIGIN_INVALID", "暂时无法完成操作，请刷新页面后重试"}
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !allowLogin(ip) {
		return apiError{429, "LOGIN_RATE_LIMIT", "登录请求过于频繁，请一分钟后重试"}
	}
	select {
	case loginSlots <- struct{}{}:
		defer func() { <-loginSlots }()
	default:
		return apiError{429, "LOGIN_BUSY", "登录繁忙，请稍后重试"}
	}
	var in struct{ Username, Password string }
	if e := body(r, &in); e != nil {
		return e
	}
	if len(in.Password) > 256 || len(in.Username) > 64 {
		return apiError{401, "LOGIN_FAILED", "账号或密码错误"}
	}
	var u user
	var h string
	var ver int
	e := a.db.QueryRow(r.Context(), "SELECT id,username,role,status,password_hash,auth_version FROM users WHERE username=$1", in.Username).Scan(&u.ID, &u.Username, &u.Role, &u.Status, &h, &ver)
	if e != nil || u.Status != "active" || !checkPassword(in.Password, h) {
		time.Sleep(250 * time.Millisecond)
		return apiError{401, "LOGIN_FAILED", "账号或密码错误，或账号已停用"}
	}
	t, c := token(), token()
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	// Serialize with password resets/disabling. Session creation and its login
	// statistic commit together; rejected or rolled-back logins never count.
	result, e := tx.Exec(r.Context(), "UPDATE users SET login_count=login_count+1,last_login_at=clock_timestamp() WHERE id=$1 AND status='active' AND auth_version=$2", u.ID, ver)
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		return apiError{401, "LOGIN_FAILED", "账号或密码错误，或账号已停用"}
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO sessions(token,user_id,auth_version,csrf,expires_at) VALUES($1,$2,$3,$4,$5)", digest(t), u.ID, ver, c, time.Now().Add(8*time.Hour))
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: a.sessionCookieName(), Value: t, Path: "/", HttpOnly: true, Secure: a.scheme == "https", SameSite: http.SameSiteLaxMode, MaxAge: 28800})
	write(w, map[string]any{"user": u, "csrfToken": c})
	return nil
}
func (a *app) owned(ctx context.Context, id, uid string) error {
	var owner string
	e := a.db.QueryRow(ctx, "SELECT owner_id FROM projects WHERE id=$1", id).Scan(&owner)
	if errors.Is(e, pgx.ErrNoRows) {
		return apiError{404, "NOT_FOUND", "项目不存在"}
	}
	if e != nil {
		return e
	}
	if owner != uid {
		return apiError{403, "FORBIDDEN", "无权操作此项目"}
	}
	return nil
}
func (a *app) publicPortSuffix() string {
	if a.port == "" || strings.EqualFold(a.scheme, "https") && a.port == "443" || strings.EqualFold(a.scheme, "http") && a.port == "80" {
		return ""
	}
	return ":" + a.port
}
func (a *app) url(public string) string {
	port := a.publicPortSuffix()
	label := public
	if !legacyPublicPattern.MatchString(public) && env("PUBLIC_URL_MODE", "path") == "path" {
		return fmt.Sprintf("%s://%s%s/%s/", a.scheme, a.domain, port, public)
	}
	if legacyPublicPattern.MatchString(public) {
		label = "p-" + public
	}
	return fmt.Sprintf("%s://%s.%s%s/", a.scheme, label, a.domain, port)
}
