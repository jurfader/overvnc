//go:build linux

package main

import (
	"context"
	"os/exec"
	"strings"
)

func listServices(ctx context.Context) ([]ServiceInfo, error) {
	units, err := exec.CommandContext(ctx, "systemctl", "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager").Output()
	if err != nil {
		return nil, err
	}
	files, _ := exec.CommandContext(ctx, "systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager").Output()
	return parseSystemctl(units, files), nil
}

func controlService(ctx context.Context, name, action string) error {
	out, err := exec.CommandContext(ctx, "systemctl", action, name+".service").CombinedOutput()
	if err != nil {
		return protoErr("svc_failed", "systemctl %s %s: %s", action, name, strings.TrimSpace(string(out)))
	}
	return nil
}
