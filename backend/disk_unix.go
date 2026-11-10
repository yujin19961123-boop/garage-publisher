//go:build !windows

package main

import "golang.org/x/sys/unix"

func diskSpace(p string) (uint64, uint64, error) {
	var s unix.Statfs_t
	e := unix.Statfs(p, &s)
	return uint64(s.Bavail) * uint64(s.Bsize), uint64(s.Blocks) * uint64(s.Bsize), e
}
