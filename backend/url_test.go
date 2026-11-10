package main

import (
	"strings"
	"testing"
)

func TestPublicDefaultPorts(t *testing.T) {
	t.Setenv("PUBLIC_URL_MODE", "path")
	legacy := strings.Repeat("a", 32)
	for _, tt := range []struct{ scheme, port, suffix string }{{"http", "80", ""}, {"https", "443", ""}, {"http", "8080", ":8080"}, {"https", "8443", ":8443"}, {"http", "", ""}, {"https", "", ""}} {
		t.Run(tt.scheme+tt.port, func(t *testing.T) {
			a := &app{scheme: tt.scheme, port: tt.port, domain: "garage.byjin.cn"}
			base := tt.scheme + "://garage.byjin.cn" + tt.suffix
			if got := a.url("youxiang"); got != base+"/youxiang/" {
				t.Fatal(got)
			}
			if got := a.shareURL("demo"); got != base+"/_share/demo/" {
				t.Fatal(got)
			}
			if got := a.url(legacy); got != tt.scheme+"://p-"+legacy+".garage.byjin.cn"+tt.suffix+"/" {
				t.Fatal(got)
			}
		})
	}
}
