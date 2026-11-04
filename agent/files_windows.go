//go:build windows

package main

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func isHidden(name string, fi fs.FileInfo) bool {
	if a, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		return a.FileAttributes&windows.FILE_ATTRIBUTE_HIDDEN != 0
	}
	return strings.HasPrefix(name, ".")
}

func protectedPaths() []string {
	sys := os.Getenv("SystemRoot")
	if sys == "" {
		sys = `C:\Windows`
	}
	drive := filepath.VolumeName(sys) + `\`
	return []string{
		sys,
		filepath.Join(sys, "System32"),
		filepath.Join(drive, "Program Files"),
		filepath.Join(drive, "Program Files (x86)"),
		filepath.Join(drive, "ProgramData"),
		filepath.Join(drive, "Users"),
		filepath.Join(drive, "Boot"),
		filepath.Join(drive, "Recovery"),
	}
}

func fsRoots(_ context.Context) []FsRoot {
	var out []FsRoot
	mask, err := windows.GetLogicalDrives()
	if err == nil {
		for i := range 26 {
			if mask&(1<<i) == 0 {
				continue
			}
			root := string(rune('A'+i)) + `:\`
			p, _ := windows.UTF16PtrFromString(root)
			if t := windows.GetDriveType(p); t == windows.DRIVE_NO_ROOT_DIR || t == windows.DRIVE_UNKNOWN {
				continue
			}
			r := FsRoot{Path: root, Label: root, Kind: "drive"}
			var free, total, totalFree uint64
			if windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree) == nil {
				r.Total, r.Free = total, free
			}
			var label [261]uint16
			if windows.GetVolumeInformation(p, &label[0], uint32(len(label)), nil, nil, nil, nil, 0) == nil {
				if l := windows.UTF16ToString(label[:]); l != "" {
					r.Label = l + " (" + root[:2] + ")"
				}
			}
			out = append(out, r)
		}
	}
	return append(out, userShortcuts()...)
}

// userShortcuts — foldery zalogowanego użytkownika (profil w C:\Users\<nazwa>).
func userShortcuts() []FsRoot {
	sys := os.Getenv("SystemDrive")
	if sys == "" {
		sys = "C:"
	}
	var out []FsRoot
	for _, full := range consoleUsers() {
		name := full[strings.LastIndex(full, `\`)+1:]
		home := filepath.Join(sys+`\`, "Users", name)
		if fi, err := os.Stat(home); err != nil || !fi.IsDir() {
			continue
		}
		out = append(out, FsRoot{Path: home, Label: "Profil (" + name + ")", Kind: "shortcut"})
		for _, d := range []struct{ dir, label string }{{"Desktop", "Pulpit"}, {"Documents", "Dokumenty"}, {"Downloads", "Pobrane"}} {
			p := filepath.Join(home, d.dir)
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				out = append(out, FsRoot{Path: p, Label: d.label, Kind: "shortcut"})
			}
		}
	}
	return out
}
