//go:build linux

package main

import (
	"context"
	"errors"
	"os/exec"
	"slices"

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
