package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

// Only const bindings to the native URL constructor (and browser location)
// qualify. Business objects named pathname and internal router strings do not.
type urlBindingCollector map[*js.Var]bool

func (c urlBindingCollector) Exit(js.INode) {}
func (c urlBindingCollector) Enter(node js.INode) js.IVisitor {
	if declaration, ok := node.(*js.VarDecl); ok && declaration.TokenType == js.ConstToken {
		for _, binding := range declaration.List {
			if name, ok := binding.Binding.(*js.Var); ok && isNativeURL(binding.Default) {
				c[canonicalVar(name)] = true
			}
		}
	}
	return c
}

func isNativeURL(value js.IExpr) bool {
	constructor, ok := value.(*js.NewExpr)
	if !ok {
		return false
	}
	name, ok := constructor.X.(*js.Var)
	return ok && string(name.Data) == "URL" && canonicalVar(name).Decl == js.NoDecl
}

type pathnameAdapter struct {
	a       pathAdapter
	urls    urlBindingCollector
	changed bool
}

func (v *pathnameAdapter) Exit(js.INode) {}
func (v *pathnameAdapter) Enter(node js.INode) js.IVisitor {
	// Native URL construction against the document's location is an explicit
	// browser URL sink, unlike an internal router string. Preserve external or
	// unknown bases and let the existing idempotent URL helper evaluate once.
	if constructor, ok := node.(*js.NewExpr); ok && isNativeURL(constructor) && constructor.Args != nil && len(constructor.Args.List) == 2 && !constructor.Args.List[0].Rest && !constructor.Args.List[1].Rest {
		base := constructor.Args.List[1].Value
		for _, property := range []string{"origin", "href"} {
			if location, ok := memberNamed(base, property); ok && isBrowserLocation(location) {
				navigation := jsAdapter{a: v.a}
				navigation.adaptNavigationValue(&constructor.Args.List[0].Value)
				v.changed = v.changed || navigation.changed
				break
			}
		}
		return v
	}
	call, ok := node.(*js.CallExpr)
	if !ok || call.Optional || len(call.Args.List) != 1 || call.Args.List[0].Rest {
		return v
	}
	method, ok := call.X.(*js.DotExpr)
	if !ok || method.Optional {
		return v
	}
	switch propertyName(method.Y) {
	case "match", "search", "matchAll":
		if v.rootPattern(call.Args.List[0].Value) {
			v.wrap(&method.X)
		}
	case "test", "exec":
		if v.rootPattern(method.X) {
			v.wrap(&call.Args.List[0].Value)
		}
	}
	return v
}

// Recognize a literal regex beginning with a complete exported top-level root.
// Preserve the regex/captures/flags instead of rewriting arbitrary regex text.
func (v *pathnameAdapter) rootPattern(value js.IExpr) bool {
	pattern, ok := value.(*js.LiteralExpr)
	if !ok || pattern.TokenType != js.RegExpToken {
		return false
	}
	text := string(pattern.Data)
	if !strings.HasPrefix(text, `/^\/`) {
		return false
	}
	rest := strings.TrimPrefix(text, `/^\/`)
	i := 0
	for i < len(rest) && (rest[i] >= 'a' && rest[i] <= 'z' || rest[i] >= 'A' && rest[i] <= 'Z' || rest[i] >= '0' && rest[i] <= '9' || rest[i] == '-' || rest[i] == '_') {
		i++
	}
	if i == 0 || !v.a.roots[rest[:i]] {
		return false
	}
	boundary := rest[i:]
	return strings.HasPrefix(boundary, `\/`) || strings.HasPrefix(boundary, `(?:\/|$)`) || strings.HasPrefix(boundary, `$/`)
}

func (v *pathnameAdapter) wrap(value *js.IExpr) {
	owner, ok := memberNamed(*value, "pathname")
	if !ok {
		return
	}
	known := isBrowserLocation(owner) || isNativeURL(owner)
	if name, ok := owner.(*js.Var); ok && v.urls[canonicalVar(name)] {
		known = true
	}
	if !known {
		return
	}
	prefix, _ := json.Marshal(v.a.prefix)
	// Evaluate the URL and pathname once, and only normalize same-origin paths.
	// A trailing slash boundary prevents /project-other from matching /project/.
	source := `(function __prototypePathname_v1(u){var s=u.pathname,p=` + string(prefix) + `;return u.origin===globalThis.location.origin&&typeof s==="string"&&s.indexOf(p)===0?s.slice(p.length-1):s;})(null);`
	ast, err := js.Parse(parse.NewInput(strings.NewReader(source)), js.Options{})
	if err != nil {
		return
	}
	call := ast.List[0].(*js.ExprStmt).Value.(*js.CallExpr)
	call.Args.List[0].Value = owner
	*value = call
	v.changed = true
}

func adaptPathnameChecks(ast *js.AST, adapter pathAdapter) bool {
	if adapter.prefix == "" || adapter.prefix == "/" {
		return false
	}
	urls := urlBindingCollector{}
	js.Walk(urls, ast)
	v := &pathnameAdapter{a: adapter, urls: urls}
	js.Walk(v, ast)
	return v.changed
}

// Existing releases stay immutable: apply the same narrow fix to JS responses.
// Older large bundles can be reuploaded through the full staging adapter. Bound
// this fallback's allocation/parse work to the same 2 MiB used by HTML fallback.
func servePrototypeWithPathnameCompatibility(w http.ResponseWriter, r *http.Request, f *os.File, info os.FileInfo, root, prefix string) bool {
	ext := strings.ToLower(filepath.Ext(info.Name()))
	const compatibilityLimit = 2 << 20
	if prefix == "" || ext != ".js" && ext != ".mjs" || info.Size() > compatibilityLimit {
		return false
	}
	data := make([]byte, info.Size())
	n, err := f.ReadAt(data, 0)
	if err != nil && err != io.EOF || int64(n) != info.Size() || !bytes.Contains(data, []byte("pathname")) && !(bytes.Contains(data, []byte("URL")) && bytes.Contains(data, []byte("location"))) {
		return false
	}
	ast, err := js.Parse(parse.NewInputBytes(data), js.Options{})
	if err != nil {
		return false // An unrelated legacy parser failure must not break serving.
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	a := pathAdapter{prefix: strings.TrimSuffix(prefix, "/") + "/", roots: map[string]bool{}}
	for _, entry := range entries {
		a.roots[entry.Name()] = true
	}
	if !adaptPathnameChecks(ast, a) {
		return false
	}
	var out cappedBuffer
	ast.JS(&out)
	if out.err != nil {
		return false
	}
	// The transformed representation has its own length/ranges. Do not use the
	// old file's Last-Modified timestamp for conditional responses to new code.
	http.ServeContent(w, r, info.Name(), time.Time{}, bytes.NewReader(out.Bytes()))
	return true
}
