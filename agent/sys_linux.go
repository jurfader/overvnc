//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os/exec"
	"slices"
	"strings"

	"github.com/shirou/gopsutil/v4/host"
)

func consoleUsers() []string {
	us, err := host.Users()
	if err != nil {
		return nil
	}
	var out []string
	for _, u := range us {
		if !slices.Contains(out, u.User) {
			out = append(out, u.User)
		}
	}
	return out
}

// installedSoftware — pakiety z pierwszego dostępnego menedżera pakietów.
func installedSoftware(ctx context.Context) ([]Software, error) {
	managers := []struct {
		bin  string
		args []string
	}{
		{"dpkg-query", []string{"-W", "-f", "${Package}\t${Version}\t${Maintainer}\n"}},
		{"rpm", []string{"-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n"}},
		{"pacman", []string{"-Q"}},
		{"apk", []string{"info", "-v"}},
	}
	for _, m := range managers {
		if _, err := exec.LookPath(m.bin); err != nil {
			continue
		}
		out, err := exec.CommandContext(ctx, m.bin, m.args...).Output()
		if err != nil {
			return nil, err
		}
		return parsePackages(m.bin, out), nil
	}
	return nil, errors.New("nie znaleziono obsługiwanego menedżera pakietów")
}

func parsePackages(manager string, out []byte) []Software {
	var list []Software
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var f []string
		switch manager {
		case "pacman":
			f = strings.SplitN(line, " ", 2)
		case "apk":
			// format: nazwa-wersja-rN
			if i := strings.LastIndex(line, "-r"); i > 0 {
				if j := strings.LastIndex(line[:i], "-"); j > 0 {
					f = []string{line[:j], line[j+1:]}
				}
			}
			if f == nil {
				f = []string{line}
			}
		default:
			f = strings.Split(line, "\t")
		}
		sw := Software{Name: f[0]}
		if len(f) > 1 {
			sw.Version = f[1]
		}
		if len(f) > 2 && f[2] != "(none)" {
			sw.Publisher = f[2]
		}
		list = append(list, sw)
	}
	return list
}
