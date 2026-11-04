//go:build !windows

package main

import "golang.org/x/sys/unix"

func freeSpace(dir string) uint64 {
	var st unix.Statfs_t
	if unix.Statfs(dir, &st) != nil {
		return 0
	}
	return uint64(st.Bavail) * uint64(st.Bsize)
}
