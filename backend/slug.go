package main

import (
	"context"
	"github.com/mozillazg/go-pinyin"
	"strconv"
	"strings"
)

const maxPublicSlugLength = 63

func (a *app) reservedSlug(s string) bool {
	if legacyPublicPattern.MatchString(s) || strings.HasPrefix(s, "p-") && legacyPublicPattern.MatchString(strings.TrimPrefix(s, "p-")) {
		return true
	}
	switch s {
	case "admin", "www", "api", "console", "preview", "localhost", "assets", "healthz", "favicon", "favicon.ico", "favicon-ico", "_share":
		return true
	}
	for _, host := range strings.Split(env("ADMIN_HOSTS", "console.localhost,console.byjin.cn"), ",") {
		if strings.TrimSpace(host) == s+"."+a.domain {
			return true
		}
	}
	return false
}

func projectSlug(name string) string {
	var b strings.Builder
	args := pinyin.NewArgs()
	args.Style = pinyin.Normal
	for _, r := range strings.ToLower(name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			continue
		}
		syllables := pinyin.LazyPinyin(string(r), args)
		if len(syllables) > 0 {
			for _, c := range strings.ReplaceAll(strings.ToLower(strings.Join(syllables, "")), "ü", "v") {
				if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' {
					b.WriteRune(c)
				} else if b.Len() > 0 {
					b.WriteByte('-')
				}
			}
		} else if b.Len() > 0 {
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	// Consecutive punctuation represents one separator.
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	if s == "" {
		s = "project"
	}
	return trimSlug(s, maxPublicSlugLength)
}

func trimSlug(s string, limit int) string {
	if len(s) > limit {
		s = s[:limit]
	}
	return strings.TrimRight(s, "-")
}

func slugCandidates(base string) []string {
	candidates := []string{trimSlug(base, maxPublicSlugLength)}
	seenPublic := map[string]bool{candidates[0]: true}
	seen := map[int]bool{}
	add := func(n int) {
		if seen[n] {
			return
		}
		seen[n] = true
		suffix := strconv.Itoa(n)
		candidate := trimSlug(base, maxPublicSlugLength-len(suffix)) + suffix
		if !seenPublic[candidate] {
			candidates = append(candidates, candidate)
			seenPublic[candidate] = true
		}
	}
	for n := 1; n <= 9; n++ {
		add(n * 111)
	}
	for n := 1; n <= 9; n++ {
		add(n * 11)
	}
	for n := 1; n <= 9; n++ {
		add(n)
	}
	for n := 1; n <= 999; n++ {
		add(n)
	}
	return candidates
}

// ON CONFLICT makes allocation safe when simultaneous creates have the same name.
func (a *app) createProject(ctx context.Context, id, owner, name string) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(92387414)"); e != nil {
		return e
	}
	for _, public := range slugCandidates(projectSlug(name)) {
		if a.reservedSlug(public) {
			continue
		}
		result, e := tx.Exec(ctx, "INSERT INTO projects(id,public_id,owner_id,name) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM deleted_project_slugs WHERE public_id=$2) ON CONFLICT(public_id) DO NOTHING", id, public, owner, name)
		if e != nil {
			return e
		}
		if result.RowsAffected() == 1 {
			return tx.Commit(ctx)
		}
	}
	return apiError{422, "PROJECT_ADDRESS_EXHAUSTED", "此名称的可用地址已用完，请换一个项目名称"}
}
