package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const platformFaviconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="17" fill="#d6dfd4"/>
  <path d="m32 12 20 20-20 20-20-20Z" fill="none" stroke="#536d5f" stroke-width="4" stroke-linejoin="round"/>
  <path d="m32 24 8 8-8 8-8-8Z" fill="#536d5f"/>
</svg>`

func platformFaviconDataURL() string {
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(platformFaviconSVG))
}

func servePlatformFavicon(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(platformFaviconSVG)))
	if r.Method != "HEAD" {
		io.WriteString(w, platformFaviconSVG)
	}
}

// Alter only a bounded HTML response prefix. Stored releases and their hashes
// remain immutable, including old versions published before this feature.
func withPrototypeFavicon(data []byte, prefix string, truncated bool) ([]byte, bool) {
	type span struct{ start, end int }
	placeholders := []span{}
	z := html.NewTokenizer(bytes.NewReader(data))
	offset := 0
	insertion := -1
	headAfter := -1
	htmlAfter := 0
	doctypeAfter := 0
	inertDepth := 0
	rawText := ""
scan:
	for {
		tokenType := z.Next()
		raw := z.Raw()
		start := offset
		offset += len(raw)
		if tokenType == html.ErrorToken {
			break
		}
		if tokenType == html.DoctypeToken {
			doctypeAfter = offset
			continue
		}
		if tokenType != html.StartTagToken && tokenType != html.SelfClosingTagToken && tokenType != html.EndTagToken {
			continue
		}
		token := z.Token()
		tag := token.Data
		if tag == "template" || tag == "noscript" {
			if tokenType == html.EndTagToken {
				if inertDepth > 0 {
					inertDepth--
				}
			} else {
				inertDepth++
			}
			continue
		}
		if inertDepth > 0 {
			continue
		}
		if tokenType == html.EndTagToken {
			if tag == rawText {
				rawText = ""
			}
			if tag == "head" {
				insertion = start
				break
			}
			continue
		}
		if tag == "html" {
			htmlAfter = offset
			continue
		}
		if tag == "head" {
			headAfter = offset
			continue
		}
		switch tag {
		case "link":
			rel, href := "", ""
			for _, attribute := range token.Attr {
				if attribute.Key == "rel" {
					rel = strings.ToLower(attribute.Val)
				}
				if attribute.Key == "href" {
					href = strings.TrimSpace(attribute.Val)
				}
			}
			icon := false
			for _, value := range strings.Fields(rel) {
				if value == "icon" {
					icon = true
				}
			}
			if icon {
				empty := href == ""
				if strings.HasPrefix(strings.ToLower(href), "data:") {
					if comma := strings.IndexByte(href, ','); comma >= 0 && strings.TrimSpace(href[comma+1:]) == "" {
						empty = true
					}
				}
				if !empty {
					return data, false
				}
				placeholders = append(placeholders, span{start, offset})
			}
		case "script", "style", "title":
			rawText = tag
		case "base", "meta":
		default:
			insertion = start
			break scan
		}
	}
	if insertion < 0 && truncated {
		return data, false
	}
	link := []byte(`<link rel="icon" type="image/svg+xml" href="` + html.EscapeString(prefix+"/.garage-favicon.svg") + `">`)
	var result bytes.Buffer
	if len(placeholders) > 0 {
		previous := 0
		for _, p := range placeholders {
			result.Write(data[previous:p.start])
			if previous == 0 || p.start == placeholders[0].start {
				result.Write(link)
			}
			previous = p.end
		}
		result.Write(data[previous:])
		return result.Bytes(), true
	}
	if insertion < 0 {
		insertion = max(doctypeAfter, htmlAfter, headAfter)
	}
	result.Write(data[:insertion])
	result.Write(link)
	result.Write(data[insertion:])
	return result.Bytes(), true
}

// Seekable prefix + original file tail preserves ServeContent's HEAD and Range
// behavior without buffering an entire (potentially 100 MiB) HTML document.
type prefixReadSeeker struct {
	prefix             []byte
	source             io.ReaderAt
	originalPrefixSize int64
	originalSize       int64
	position           int64
}

func (r *prefixReadSeeker) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	length := int64(len(r.prefix)) + r.originalSize - r.originalPrefixSize
	if r.position >= length {
		return 0, io.EOF
	}
	n := 0
	if r.position < int64(len(r.prefix)) {
		n = copy(p, r.prefix[r.position:])
		r.position += int64(n)
		p = p[n:]
	}
	if len(p) == 0 {
		return n, nil
	}
	if r.position >= length {
		return n, io.EOF
	}
	amount := min(int64(len(p)), length-r.position)
	read, e := r.source.ReadAt(p[:amount], r.originalPrefixSize+r.position-int64(len(r.prefix)))
	r.position += int64(read)
	return n + read, e
}
func (r *prefixReadSeeker) Seek(offset int64, whence int) (int64, error) {
	position := offset
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		position += r.position
	case io.SeekEnd:
		position += int64(len(r.prefix)) + r.originalSize - r.originalPrefixSize
	default:
		return 0, fmt.Errorf("invalid seek origin")
	}
	if position < 0 {
		return 0, fmt.Errorf("negative seek position")
	}
	r.position = position
	return position, nil
}

func servePrototypeWithFavicon(w http.ResponseWriter, r *http.Request, f *os.File, info os.FileInfo, prefix string) bool {
	ext := strings.ToLower(filepath.Ext(info.Name()))
	if ext != ".html" && ext != ".htm" {
		return false
	}
	const headLimit = 2 << 20
	data := make([]byte, min(info.Size(), headLimit))
	n, e := f.ReadAt(data, 0)
	if e != nil && e != io.EOF {
		return false
	}
	data = data[:n]
	head, changed := withPrototypeFavicon(data, prefix, info.Size() > int64(len(data)))
	if !changed {
		return false
	}
	reader := &prefixReadSeeker{prefix: head, source: f, originalPrefixSize: int64(len(data)), originalSize: info.Size()}
	http.ServeContent(w, r, info.Name(), time.Time{}, reader)
	return true
}
