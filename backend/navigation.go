package main

import (
	"encoding/json"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

func memberNamed(e js.IExpr, name string) (js.IExpr, bool) {
	d, ok := e.(*js.DotExpr)
	if !ok || d.Optional {
		return nil, false
	}
	return d.X, propertyName(d.Y) == name
}

func isBrowserLocation(e js.IExpr) bool {
	if v, ok := e.(*js.Var); ok && string(v.Data) == "location" && canonicalVar(v).Decl == js.NoDecl {
		return true
	}
	owner, ok := memberNamed(e, "location")
	if !ok {
		return false
	}
	v, ok := owner.(*js.Var)
	return ok && (string(v.Data) == "window" || string(v.Data) == "self" || string(v.Data) == "globalThis") && canonicalVar(v).Decl == js.NoDecl
}

func isLocationNavigation(e js.IExpr) bool {
	for _, method := range []string{"assign", "replace"} {
		if location, ok := memberNamed(e, method); ok && isBrowserLocation(location) {
			return true
		}
	}
	return false
}

func isLocationHref(e js.IExpr) bool {
	location, ok := memberNamed(e, "href")
	return ok && isBrowserLocation(location)
}

func navigationWrapped(e js.IExpr) bool {
	call, ok := e.(*js.CallExpr)
	if !ok {
		return false
	}
	group, ok := call.X.(*js.GroupExpr)
	if !ok {
		return false
	}
	f, ok := group.X.(*js.FuncDecl)
	return ok && f.Name != nil && string(f.Name.Data) == "__prototypeLocalURL_v1"
}

// Runtime-computed URLs are adapted only at explicit navigation/resource sinks.
// The argument is evaluated once. Unknown roots, API URLs, external URLs, objects
// and already-prefixed URLs retain their original value; no browser API is patched.
func (v *jsAdapter) adaptNavigationValue(value *js.IExpr) {
	if value == nil || *value == nil || navigationWrapped(*value) {
		return
	}
	switch n := (*value).(type) {
	case *js.LiteralExpr:
		if n.TokenType == js.StringToken && (string(n.Data) == `"/"` || string(n.Data) == `'/'`) {
			n.Data, _ = json.Marshal(v.a.prefix)
			v.changed = true
		}
		return
	case *js.FuncDecl, *js.ArrowFunc, *js.MethodDecl:
		return // Static strings are handled by the normal string visitor.
	}
	prefix, _ := json.Marshal(v.a.prefix)
	roots, _ := json.Marshal(v.a.roots)
	source := `(function __prototypeLocalURL_v1(s){var p=` + string(prefix) + `,r=` + string(roots) + `;if(typeof s!=="string"||s[0]!=="/"||s[1]==="/"||s===p.slice(0,-1)||s.indexOf(p)===0)return s;if(s==="/"||s[1]==="?"||s[1]==="#"||Object.prototype.hasOwnProperty.call(r,s.slice(1).split(/[/?#]/,1)[0]))return p+s.slice(1);return s;})(null);`
	ast, err := js.Parse(parse.NewInput(strings.NewReader(source)), js.Options{})
	if err != nil {
		return // The helper source is generated exclusively from JSON-encoded values.
	}
	call := ast.List[0].(*js.ExprStmt).Value.(*js.CallExpr)
	call.Args.List[0].Value = *value
	*value = call
	v.changed = true
}
