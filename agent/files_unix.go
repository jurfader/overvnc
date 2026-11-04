//go:build !windows

package main

import (
	"context"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/v4/disk"
)

func isHidden(name string, _ fs.FileInfo) bool { return strings.HasPrefix(name, ".") }

func protectedPaths() []string {
	common := []string{"/bin", "/sbin", "/etc", "/usr", "/var", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/root", "/home", "/opt", "/tmp"}
	if runtime.GOOS == "darwin" {
		common = append(common, "/System", "/Library", "/Applications", "/Users", "/private", "/private/etc", "/private/var", "/Volumes", "/cores")
	}
	return common
}

func fsRoots(ctx context.Context) []FsRoot {
	var out []FsRoot
	seen := map[string]bool{}
	for _, p := range relevantPartitions(ctx) {
		if seen[p.Mountpoint] {
			continue
		}
		seen[p.Mountpoint] = true
		r := FsRoot{Path: p.Mountpoint, Label: p.Mountpoint, Kind: "drive"}
		if p.Mountpoint == "/" {
			r.Label = "Dysk systemowy"
		} else {
			r.Label = filepath.Base(p.Mountpoint)
		}
		if u, err := disk.UsageWithContext(ctx, p.Mountpoint); err == nil {
			r.Total, r.Free = u.Total, u.Free
		}
		out = append(out, r)
	}
	if !seen["/"] {
		out = append([]FsRoot{{Path: "/", Label: "Dysk systemowy", Kind: "drive"}}, out...)
	}
	return append(out, userShortcuts()...)
}

// userShortcuts — Pulpit, Dokumenty, Pobrane zalogowanego użytkownika (lub konta agenta).
func userShortcuts() []FsRoot {
	var homes []string
	for _, name := range consoleUsers() {
		if u, err := user.Lookup(name); err == nil {
			homes = append(homes, u.HomeDir)
		}
	}
	if len(homes) == 0 {
		if h, err := os.UserHomeDir(); err == nil {
			homes = append(homes, h)
		}
	}
	var out []FsRoot
	for _, h := range homes {
		out = append(out, FsRoot{Path: h, Label: "Katalog domowy (" + filepath.Base(h) + ")", Kind: "shortcut"})
		for _, d := range []struct{ dir, label string }{{"Desktop", "Pulpit"}, {"Documents", "Dokumenty"}, {"Downloads", "Pobrane"}} {
			p := filepath.Join(h, d.dir)
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				out = append(out, FsRoot{Path: p, Label: d.label, Kind: "shortcut"})
			}
		}
	}
	return out
}
