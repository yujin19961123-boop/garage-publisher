package main

import (
	"bytes"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
	"github.com/tdewolff/parse/v2/js"
	"golang.org/x/net/html"
)

type pathAdapter struct {
	prefix string
	roots  map[string]bool
}

func (a pathAdapter) rewrite(s string) string {
	if !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, a.prefix) {
		return s
	}
	if strings.HasPrefix(s, "/?") || strings.HasPrefix(s, "/#") {
		return a.prefix + s[1:]
	}
	first := strings.SplitN(strings.TrimPrefix(s, "/"), "/", 2)[0]
	first = strings.SplitN(strings.SplitN(first, "?", 2)[0], "#", 2)[0]
	if a.roots[first] {
		return a.prefix + s[1:]
	}
	return s
}

type jsAdapter struct {
	a       pathAdapter
	changed bool
}

func (v *jsAdapter) Exit(js.INode) {}
func (v *jsAdapter) Enter(n js.INode) js.IVisitor {
	switch n := n.(type) {
	case *js.CallExpr:
		if isLocationNavigation(n.X) && len(n.Args.List) > 0 && !n.Args.List[0].Rest {
			v.adaptNavigationValue(&n.Args.List[0].Value)
		}
	case *js.BinaryExpr:
		if n.Op == js.EqToken && isLocationHref(n.X) {
			v.adaptNavigationValue(&n.Y)
		}
	case *js.Property:
		if n.Name != nil && (n.Name.IsIdent([]byte("href")) || n.Name.IsIdent([]byte("src")) || n.Name.IsIdent([]byte("action")) || n.Name.IsIdent([]byte("poster"))) {
			v.adaptNavigationValue(&n.Value)
		}
	case *js.ImportStmt:
		n.Module = v.module(n.Module)
	case *js.ExportStmt:
		n.Module = v.module(n.Module)
	case *js.LiteralExpr:
		if n.TokenType == js.StringToken && len(n.Data) >= 2 {
			old := string(n.Data[1 : len(n.Data)-1])
			s := v.a.rewrite(old)
			if s != old {
				n.Data = append(append([]byte{n.Data[0]}, []byte(s)...), n.Data[len(n.Data)-1])
				v.changed = true
			}
		}
	case *js.TemplateExpr:
		if n.Tag == nil {
			if len(n.List) > 0 {
				data := n.List[0].Value
				if len(data) > 2 {
					old := string(data[1 : len(data)-2])
					s := v.a.rewrite(old)
					if s != old {
						n.List[0].Value = []byte(string(data[:1]) + s + "${")
						v.changed = true
					}
				}
			} else if len(n.Tail) >= 2 {
				old := string(n.Tail[1 : len(n.Tail)-1])
				s := v.a.rewrite(old)
				if s != old {
					n.Tail = []byte("`" + s + "`")
					v.changed = true
				}
			}
		}
	}
	return v
}
func (v *jsAdapter) module(data []byte) []byte {
	if len(data) < 2 {
		return data
	}
	old := string(data[1 : len(data)-1])
	s := v.a.rewrite(old)
	if s == old {
		return data
	}
	v.changed = true
	return []byte(string(data[:1]) + s + string(data[len(data)-1:]))
}

type cappedBuffer struct {
	bytes.Buffer
	err error
}

func (b *cappedBuffer) WriteString(s string) (int, error) { return b.Write([]byte(s)) }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if int64(b.Len()+len(p)) > maxFile {
		b.err = fmt.Errorf("适配后的文件过大，请减少网页内容后重试")
		return 0, b.err
	}
	return b.Buffer.Write(p)
}
func (a pathAdapter) javascript(data []byte) ([]byte, error) {
	ast, e := js.Parse(parse.NewInputBytes(data), js.Options{})
	if e != nil {
		return nil, fmt.Errorf("网页脚本无法适配，请重新导出完整静态网页后上传")
	}
	v := &jsAdapter{a: a}
	v.changed = adaptVitePreloader(ast, data, a.prefix)
	if adaptNextRuntime(ast, data, a.prefix) {
		v.changed = true
	}
	js.Walk(v, ast)
	if !v.changed {
		return data, nil
	}
	var b cappedBuffer
	ast.JS(&b)
	if b.err != nil {
		return nil, b.err
	}
	return b.Bytes(), nil
}
func (a pathAdapter) stylesheet(data []byte) ([]byte, error) {
	l := css.NewLexer(parse.NewInputBytes(data))
	var b cappedBuffer
	importing := false
	for {
		tt, token := l.Next()
		if tt == css.ErrorToken {
			if l.Err() != io.EOF {
				return nil, fmt.Errorf("网页样式无法适配，请重新导出后上传")
			}
			break
		}
		if tt == css.BadURLToken || tt == css.BadStringToken {
			return nil, fmt.Errorf("网页样式中的资源地址无效，请重新导出后上传")
		}
		if tt == css.AtKeywordToken {
			importing = strings.EqualFold(string(token), "@import")
		}
		if importing && tt == css.StringToken && len(token) >= 2 {
			old := string(token[1 : len(token)-1])
			s := a.rewrite(old)
			if s != old {
				token = []byte(string(token[:1]) + s + string(token[len(token)-1:]))
			}
			importing = false
		}
		if tt == css.URLToken {
			raw := string(token)
			open := strings.IndexByte(raw, '(')
			inside := strings.TrimSpace(strings.TrimSuffix(raw[open+1:], ")"))
			quote := ""
			if len(inside) >= 2 && (inside[0] == '\'' || inside[0] == '"') {
				quote = inside[:1]
				inside = inside[1 : len(inside)-1]
			}
			s := a.rewrite(inside)
			if s != inside {
				token = []byte("url(" + quote + s + quote + ")")
			}
		}
		b.Write(token)
		if tt == css.URLToken || tt == css.SemicolonToken {
			importing = false
		}
	}
	if b.err != nil {
		return nil, b.err
	}
	return b.Bytes(), nil
}
func localResource(s string) bool {
	u, e := url.Parse(s)
	return e == nil && u.Scheme == "" && u.Host == "" && !strings.HasPrefix(s, "#") && s != ""
}
func (a pathAdapter) markup(data []byte) ([]byte, error) {
	z := html.NewTokenizer(bytes.NewReader(data))
	var b cappedBuffer
	inline := ""
	next := bytes.Contains(data, []byte("__next_f")) || bytes.Contains(data, []byte("__NEXT_DATA__"))
	icon := false
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			if z.Err() != io.EOF {
				return nil, fmt.Errorf("网页文件无法读取，请重新导出后上传")
			}
			break
		}
		raw := append([]byte(nil), z.Raw()...)
		if tt == html.StartTagToken || tt == html.SelfClosingTagToken {
			t := z.Token()
			local := false
			scriptType := ""
			for _, attr := range t.Attr {
				if t.Data == "link" && attr.Key == "rel" {
					for _, rel := range strings.Fields(strings.ToLower(attr.Val)) {
						icon = icon || rel == "icon"
					}
				}
				if (attr.Key == "src" || attr.Key == "href") && localResource(attr.Val) {
					local = true
				}
				if attr.Key == "type" {
					scriptType = attr.Val
				}
			}
			attrs := t.Attr[:0]
			for _, attr := range t.Attr {
				if attr.Key == "integrity" && local && (t.Data == "script" || t.Data == "link") {
					continue
				}
				switch attr.Key {
				case "srcset":
					attr.Val = a.srcset(attr.Val)
				case "src", "href", "action", "poster":
					if t.Data == "base" && attr.Key == "href" && attr.Val == "/" {
						attr.Val = a.prefix
					} else {
						attr.Val = a.rewrite(attr.Val)
					}
				case "style":
					s, e := a.stylesheet([]byte(attr.Val))
					if e != nil {
						return nil, e
					}
					attr.Val = string(s)
				}
				attrs = append(attrs, attr)
			}
			t.Attr = attrs
			b.Write([]byte(t.String()))
			inline = ""
			if t.Data == "script" && (scriptType == "" || scriptType == "module" || strings.Contains(scriptType, "javascript")) {
				inline = "js"
			}
			if t.Data == "style" {
				inline = "css"
			}
		} else if tt == html.TextToken && inline != "" {
			var out []byte
			var e error
			if inline == "js" {
				out, e = a.javascript(raw)
			} else {
				out, e = a.stylesheet(raw)
			}
			if e != nil {
				return nil, e
			}
			b.Write(out)
		} else {
			if tt == html.EndTagToken && next && !icon && z.Token().Data == "head" {
				// Prevent Chrome's implicit origin-level /favicon.ico request from
				// escaping a static export that did not include a favicon.
				b.WriteString(`<link rel="icon" href="data:,">`)
			}
			b.Write(raw)
			if tt == html.EndTagToken {
				inline = ""
			}
		}
	}
	if b.err != nil {
		return nil, b.err
	}
	return b.Bytes(), nil
}
func (a pathAdapter) srcset(s string) string {
	if strings.Contains(strings.ToLower(s), "data:") {
		return s
	}
	parts := strings.Split(s, ",")
	for i, p := range parts {
		fields := strings.Fields(p)
		if len(fields) > 0 {
			fields[0] = a.rewrite(fields[0])
			parts[i] = strings.Join(fields, " ")
		}
	}
	return strings.Join(parts, ", ")
}

// Adapt a private staging directory only. Archive and published directories are untouched.
func adaptPathResources(root, prefix string) error {
	entries, e := os.ReadDir(root)
	if e != nil {
		return e
	}
	a := pathAdapter{prefix: prefix, roots: map[string]bool{}}
	for _, entry := range entries {
		a.roots[entry.Name()] = true
	}
	var total int64
	files := []string{}
	e = filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
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
		total += info.Size()
		files = append(files, p)
		return nil
	})
	if e != nil {
		return e
	}
	for _, p := range files {
		ext := strings.ToLower(filepath.Ext(p))
		if ext != ".html" && ext != ".js" && ext != ".mjs" && ext != ".css" {
			continue
		}
		data, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		var out []byte
		switch ext {
		case ".html":
			out, e = a.markup(data)
		case ".css":
			out, e = a.stylesheet(data)
		default:
			out, e = a.javascript(data)
		}
		if e != nil {
			return e
		}
		total += int64(len(out) - len(data))
		if int64(len(out)) > maxFile || total > maxExpanded {
			return fmt.Errorf("适配后的网页内容过大，请减少文件后重新上传")
		}
		if !bytes.Equal(data, out) {
			if e = os.WriteFile(p, out, 0600); e != nil {
				return e
			}
		}
	}
	return adaptNextStaticPayloads(root, prefix)
}
