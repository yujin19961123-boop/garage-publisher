package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tdewolff/parse/v2/js"
)

// Next exports may encode a segment key as nested filesystem components while
// the browser requests the dot-joined segment filename. This alias is limited
// to missing Next payload files; it is never a general URL-to-file rewrite.
func resolveNextStaticPayload(root, raw string) (string, os.FileInfo, error) {
	missing := func() (string, os.FileInfo, error) { return "", nil, os.ErrNotExist }
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.ContainsAny(raw, "\\\x00:%?#") || path.Clean(raw) != raw {
		return missing()
	}
	for _, segment := range strings.Split(strings.TrimPrefix(raw, "/"), "/") {
		if segment == "" || strings.HasPrefix(segment, ".") {
			return missing()
		}
	}
	absolute, e := filepath.Abs(root)
	if e != nil {
		return "", nil, e
	}
	original := filepath.Join(absolute, filepath.FromSlash(strings.TrimPrefix(raw, "/")))
	if info, e := os.Stat(original); e == nil {
		return original, info, nil
	} else if !os.IsNotExist(e) {
		return "", nil, e
	}
	base := path.Base(raw)
	if !strings.HasPrefix(base, "__next.") || !strings.HasSuffix(base, ".txt") {
		return missing()
	}
	detected, e := isNextStaticExport(absolute)
	if e != nil {
		return "", nil, e
	}
	if !detected {
		return missing()
	}
	key := strings.TrimSuffix(strings.TrimPrefix(base, "__next."), ".txt")
	segments := strings.Split(key, ".")
	if len(segments) < 2 {
		return missing()
	}
	for _, segment := range segments {
		if segment == "" {
			return missing()
		}
		for _, r := range segment {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-$()[]@", r)) {
				return missing()
			}
		}
	}
	segments[0] = "__next." + segments[0]
	segments[len(segments)-1] += ".txt"
	components := append([]string{absolute, filepath.FromSlash(strings.TrimPrefix(path.Dir(raw), "/"))}, segments...)
	candidate := filepath.Join(components...)
	rel, e := filepath.Rel(absolute, candidate)
	if e != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return missing()
	}
	// Uploaded symlinks are already rejected, but the resolver also refuses
	// linked aliases if a storage directory was altered outside the uploader.
	current := absolute
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		current = filepath.Join(current, part)
		info, e := os.Lstat(current)
		if e != nil {
			return "", nil, e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return missing()
		}
	}
	info, e := os.Stat(candidate)
	if e != nil {
		return "", nil, e
	}
	if !info.Mode().IsRegular() {
		return missing()
	}
	return candidate, info, nil
}

// Detect exported Next pages without treating an arbitrary JS project as Next.
func isNextStaticExport(root string) (bool, error) {
	info, e := os.Stat(filepath.Join(root, "_next"))
	if os.IsNotExist(e) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if !info.IsDir() {
		return false, nil
	}
	data, e := os.ReadFile(filepath.Join(root, "index.html"))
	if e != nil {
		return false, e
	}
	return bytes.Contains(data, []byte("__next_f")) || bytes.Contains(data, []byte("__NEXT_DATA__")), nil
}

// Call once on the private staging directory after normal resource adaptation.
// Next's static RSC responses live in index.txt, route.txt and __next.* payloads.
func adaptNextStaticPayloads(root, prefix string) error {
	detected, e := isNextStaticExport(root)
	if e != nil || !detected {
		return e
	}
	var total int64
	return filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		size := info.Size()
		eligible := strings.EqualFold(filepath.Ext(p), ".txt") || strings.HasPrefix(d.Name(), "__next.")
		if eligible {
			if size > maxFile {
				return fmt.Errorf("网页数据文件过大，请减少内容后重试")
			}
			data, e := os.ReadFile(p)
			if e != nil {
				return e
			}
			if out, changed := adaptNextFlightPayload(string(data), prefix); changed {
				size = int64(len(out))
				if size > maxFile {
					return fmt.Errorf("适配后的网页数据过大，请减少内容后重试")
				}
				if e = os.WriteFile(p, []byte(out), 0600); e != nil {
					return e
				}
			}
		}
		total += size
		if total > maxExpanded {
			return fmt.Errorf("适配后的网页内容过大，请减少内容后重试")
		}
		return nil
	})
}

// Next Flight embeds a record stream inside a JavaScript string. Only JSON
// string values representing Next-owned asset URLs are adapted; route trees,
// canonical URL segments, ordinary text, and arbitrary JS strings are untouched.
func adaptNextFlightPayload(payload, prefix string) (string, bool) {
	var out strings.Builder
	changed := false
	for i := 0; i < len(payload); {
		// Flight T records contain byte-length-prefixed arbitrary text. Their
		// bytes must stay exact, even when the text happens to look like JSON.
		if i == 0 || payload[i-1] == '\n' {
			if colon := strings.IndexByte(payload[i:], ':'); colon >= 0 && colon < 16 {
				start := i + colon + 1
				if start < len(payload) && payload[start] == 'T' {
					comma := strings.IndexByte(payload[start+1:], ',')
					if comma >= 1 && comma < 16 {
						headerEnd := start + 1 + comma
						count, err := strconv.ParseUint(payload[start+1:headerEnd], 16, 32)
						if err == nil && count <= uint64(len(payload)-headerEnd-1) {
							end := headerEnd + 1 + int(count)
							out.WriteString(payload[i:end])
							i = end
							continue
						}
					}
				}
			}
		}
		if payload[i] != '"' {
			out.WriteByte(payload[i])
			i++
			continue
		}
		start := i
		i++
		closed := false
		for i < len(payload) {
			if payload[i] == '\\' {
				i += 2
				continue
			}
			if payload[i] == '"' {
				i++
				closed = true
				break
			}
			i++
		}
		if !closed || i > len(payload) {
			out.WriteString(payload[start:])
			break
		}
		raw := payload[start:i]
		var value string
		if json.Unmarshal([]byte(raw), &value) == nil && strings.HasPrefix(value, "/_next/") && !strings.HasPrefix(value, prefix) {
			value = prefix + strings.TrimPrefix(value, "/")
			encoded, _ := json.Marshal(value)
			out.Write(encoded)
			changed = true
		} else {
			out.WriteString(raw)
		}
	}
	if !changed {
		return payload, false
	}
	return out.String(), true
}

type nextFlightVisitor struct {
	prefix  string
	changed bool
}

func (v *nextFlightVisitor) Exit(js.INode) {}
func propertyName(e js.IExpr) string {
	switch x := e.(type) {
	case *js.Var:
		return string(x.Name())
	case *js.LiteralExpr:
		return strings.Trim(string(x.Data), "\"'")
	case js.LiteralExpr:
		return strings.Trim(string(x.Data), "\"'")
	}
	return ""
}
func isNextFlightPush(e js.IExpr) bool {
	push, ok := e.(*js.DotExpr)
	if !ok || propertyName(push.Y) != "push" {
		return false
	}
	flight, ok := push.X.(*js.DotExpr)
	if !ok || propertyName(flight.Y) != "__next_f" {
		return false
	}
	owner, ok := flight.X.(*js.Var)
	return ok && (string(owner.Name()) == "self" || string(owner.Name()) == "window")
}
func (v *nextFlightVisitor) Enter(n js.INode) js.IVisitor {
	call, ok := n.(*js.CallExpr)
	if !ok || !isNextFlightPush(call.X) || len(call.Args.List) != 1 {
		return v
	}
	array, ok := call.Args.List[0].Value.(*js.ArrayExpr)
	if !ok || len(array.List) != 2 {
		return v
	}
	kind, ok := array.List[0].Value.(*js.LiteralExpr)
	if !ok || string(kind.Data) != "1" {
		return v
	}
	literal, ok := array.List[1].Value.(*js.LiteralExpr)
	if !ok || literal.TokenType != js.StringToken {
		return v
	}
	var payload string
	if json.Unmarshal(literal.Data, &payload) != nil {
		return v
	}
	if adapted, changed := adaptNextFlightPayload(payload, v.prefix); changed {
		literal.Data, _ = json.Marshal(adapted)
		v.changed = true
	}
	return v
}

// Called alongside adaptVitePreloader, before the normal JS AST walk.
// Existing webpack publicPath '/_next/' is already handled by pathAdapter.
// Compiled Next router basePath is deliberately not partially patched here.
func adaptNextRuntime(ast *js.AST, source []byte, prefix string) bool {
	if !bytes.Contains(source, []byte("__next_f")) || !bytes.Contains(source, []byte("/_next/")) {
		return false
	}
	visitor := &nextFlightVisitor{prefix: prefix}
	js.Walk(visitor, ast)
	return visitor.changed
}
