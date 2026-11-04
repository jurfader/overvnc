//go:build darwin

package main

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"howett.net/plist"
)

// consoleUsers — użytkownik zalogowany przy ekranie (właściciel /dev/console).
func consoleUsers() []string {
	fi, err := os.Stat("/dev/console")
	if err != nil {
		return nil
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	u, err := user.LookupId(strconv.Itoa(int(st.Uid)))
	if err != nil || u.Username == "root" {
		return nil
	}
	return []string{u.Username}
}

// installedSoftware — aplikacje .app z /Applications (wraz z jednym poziomem podfolderów).
func installedSoftware(ctx context.Context) ([]Software, error) {
	var apps []string
	for _, dir := range []string{"/Applications", "/Applications/Utilities"} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if strings.HasSuffix(e.Name(), ".app") {
				apps = append(apps, p)
			} else if e.IsDir() && dir == "/Applications" && e.Name() != "Utilities" {
				sub, _ := filepath.Glob(filepath.Join(p, "*.app"))
				apps = append(apps, sub...)
			}
		}
	}

	var out []Software
	for _, app := range apps {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		sw := Software{Name: strings.TrimSuffix(filepath.Base(app), ".app")}
		if data, err := os.ReadFile(filepath.Join(app, "Contents", "Info.plist")); err == nil {
			var info struct {
				Version   string `plist:"CFBundleShortVersionString"`
				Copyright string `plist:"NSHumanReadableCopyright"`
			}
			if _, err := plist.Unmarshal(data, &info); err == nil {
				sw.Version = info.Version
			}
		}
		out = append(out, sw)
	}
	return out, nil
}
