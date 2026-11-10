//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"path/filepath"
)

func diskSpace(p string) (uint64, uint64, error) {
	p, e := filepath.Abs(p)
	if e != nil {
		return 0, 0, e
	}
	s, e := windows.UTF16PtrFromString(p)
	if e != nil {
		return 0, 0, e
	}
	var free, total, all uint64
	e = windows.GetDiskFreeSpaceEx(s, &free, &total, &all)
	return free, total, e
}
