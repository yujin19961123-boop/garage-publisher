package main

import (
	"bytes"
	"github.com/tdewolff/parse/v2/js"
)

type viteFrame struct {
	calls  map[*js.Var]bool
	marker bool
	nonce  bool
}
type viteCollector struct {
	frames  []*viteFrame
	all     []*viteFrame
	helpers map[*js.Var]func(string)
}

func canonicalVar(v *js.Var) *js.Var {
	for v != nil && v.Link != nil {
		v = v.Link
	}
	return v
}
func pureRootJoin(params js.Params, body js.BlockStmt) func(string) {
	if len(params.List) != 1 || params.Rest != nil || params.List[0].Default != nil || len(body.List) != 1 {
		return nil
	}
	param, ok := params.List[0].Binding.(*js.Var)
	if !ok {
		return nil
	}
	ret, ok := body.List[0].(*js.ReturnStmt)
	if !ok {
		return nil
	}
	isParam := func(e js.IExpr) bool { v, ok := e.(*js.Var); return ok && canonicalVar(v) == canonicalVar(param) }
	if b, ok := ret.Value.(*js.BinaryExpr); ok && b.Op == js.AddToken && isParam(b.Y) {
		switch x := b.X.(type) {
		case *js.LiteralExpr:
			if x.TokenType == js.StringToken && (string(x.Data) == `"/"` || string(x.Data) == `'/'`) {
				return func(prefix string) { x.Data = []byte(`"` + prefix + `"`) }
			}
		case *js.TemplateExpr:
			if x.Tag == nil && len(x.List) == 0 && string(x.Tail) == "`/`" {
				return func(prefix string) { x.Tail = []byte("`" + prefix + "`") }
			}
		}
	}
	if t, ok := ret.Value.(*js.TemplateExpr); ok && t.Tag == nil && len(t.List) == 1 && isParam(t.List[0].Expr) && string(t.List[0].Value) == "`/${" && string(t.Tail) == "}`" {
		return func(prefix string) { t.List[0].Value = []byte("`" + prefix + "${") }
	}
	return nil
}
func (v *viteCollector) addHelper(binding *js.Var, expr js.IExpr) {
	var rewrite func(string)
	switch n := expr.(type) {
	case *js.FuncDecl:
		if !n.Async && !n.Generator {
			rewrite = pureRootJoin(n.Params, n.Body)
		}
	case *js.ArrowFunc:
		if !n.Async {
			rewrite = pureRootJoin(n.Params, n.Body)
		}
	}
	if rewrite != nil {
		v.helpers[canonicalVar(binding)] = rewrite
	}
}
func (v *viteCollector) Enter(n js.INode) js.IVisitor {
	switch n := n.(type) {
	case *js.VarDecl:
		for _, b := range n.List {
			if binding, ok := b.Binding.(*js.Var); ok {
				v.addHelper(binding, b.Default)
			}
		}
	case *js.FuncDecl:
		if n.Name != nil {
			v.addHelper(n.Name, n)
		}
		f := &viteFrame{calls: map[*js.Var]bool{}}
		v.frames = append(v.frames, f)
		v.all = append(v.all, f)
	case *js.ArrowFunc:
		f := &viteFrame{calls: map[*js.Var]bool{}}
		v.frames = append(v.frames, f)
		v.all = append(v.all, f)
	case *js.CallExpr:
		if called, ok := n.X.(*js.Var); ok {
			for _, f := range v.frames {
				f.calls[canonicalVar(called)] = true
			}
		}
	case *js.LiteralExpr:
		if n.TokenType == js.StringToken {
			for _, f := range v.frames {
				if bytes.Contains(n.Data, []byte("vite:preloadError")) {
					f.marker = true
				}
				if bytes.Contains(n.Data, []byte("csp-nonce")) {
					f.nonce = true
				}
			}
		}
	case *js.TemplateExpr:
		for _, f := range v.frames {
			if bytes.Contains(n.Tail, []byte("vite:preloadError")) {
				f.marker = true
			}
			if bytes.Contains(n.Tail, []byte("csp-nonce")) {
				f.nonce = true
			}
		}
	}
	return v
}
func (v *viteCollector) Exit(n js.INode) {
	switch n.(type) {
	case *js.FuncDecl, *js.ArrowFunc:
		v.frames = v.frames[:len(v.frames)-1]
	}
}

// Vite's dependency map stores assets/... and its preload helper prepends '/'.
// Rewrite that pure join only when referenced by the identified preload function.
func adaptVitePreloader(ast *js.AST, source []byte, prefix string) bool {
	if !bytes.Contains(source, []byte("__vite__mapDeps")) || !bytes.Contains(source, []byte("vite:preloadError")) {
		return false
	}
	v := &viteCollector{helpers: map[*js.Var]func(string){}}
	js.Walk(v, ast)
	changed := false
	done := map[*js.Var]bool{}
	for _, f := range v.all {
		if !f.marker || !f.nonce {
			continue
		}
		for called := range f.calls {
			if rewrite := v.helpers[called]; rewrite != nil && !done[called] {
				rewrite(prefix)
				done[called] = true
				changed = true
			}
		}
	}
	return changed
}
